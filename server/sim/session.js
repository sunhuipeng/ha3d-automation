'use strict';
/* 仿真会话：虚拟世界（实体表 / 上下文桶 / 写意图 / 日志 / 快照）。
 * 会话按 scriptId 唯一（影子槽位唯一），生命周期 = simulate 实例，切模式/关闭即销毁。
 *
 * 数据来源全部来自 MCP 注入与脚本写回，接触真实世界的通道只有脚本源码（只读），
 * 不写 data/context.json、不写版本日志、不进真实订阅表。 */
const { isDeepStrictEqual } = require('node:util');
const { VirtualClock } = require('./clock');
const { createSimHost } = require('./host');

function clone(v) {
  if (v == null) return v;
  return JSON.parse(JSON.stringify(v));
}

/* 每个 step 结束排空微任务 + setImmediate，确保注入触发的异步续体跑完（§12 异步竞态）。 */
function drain() {
  return new Promise((resolve) => { Promise.resolve().then(() => setImmediate(resolve)); });
}

function deepEqual(a, b) { return isDeepStrictEqual(a, b); }

/* 写意图部分匹配：只对期望项出现的字段比较（seq/at 等运行时字段不进期望）。
 * args 走严格 deep equal；kind 区分 write / service / context（§7.2）。 */
function matchWrite(exp, act) {
  if (!exp || typeof exp !== 'object') return false;
  for (const k of ['kind', 'op', 'nodeId', 'desc']) {
    if (exp[k] !== undefined && exp[k] !== act[k]) return false;
  }
  if (exp.args !== undefined && !deepEqual(exp.args, act.args)) return false;
  return true;
}

function asArray(v) { return Array.isArray(v) ? v : [v]; }

/* ---------- 断言 DSL（P2）：路径 + 算子 + 组合，无 eval ----------
 * 路径语法：writes[0].op / logs[-1].message / context.global['waterHeater.avoiding'] /
 *          entities['sensor.power'].state / stats.sent / execution.state / timers.length
 * 谓词：{ path, eq|ne|gt|gte|lt|lte|match|includes|exists|type }，数组=全部满足（AND）；
 *      组合：{ all:[...] } / { any:[...] } / { not: {...} }。
 * 结果只用于 AI 断言与回归，不执行脚本，注册表里没有 eval/Function。 */
const PATH_TOKEN = /\[(\d+)\]|\[['"]([^'"]+)['"]\]|([^.\[\]]+)/g;

function parsePath(p) {
  const out = [];
  const s = String(p == null ? '' : p);
  PATH_TOKEN.lastIndex = 0;
  let m;
  while ((m = PATH_TOKEN.exec(s))) {
    if (m[1] !== undefined) out.push(Number(m[1]));
    else if (m[2] !== undefined) out.push(m[2]);
    else out.push(m[3]);
  }
  return out;
}

function readPath(root, path) {
  let cur = root;
  for (const seg of parsePath(path)) {
    if (cur == null) return undefined;
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg < 0 ? cur.length + seg : seg];
    } else {
      if (typeof cur !== 'object') return undefined;
      cur = cur[seg];
    }
  }
  return cur;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

const NUM_OPS = {
  gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b,
};

/* 单谓词求值，返回 { pass, message }。未知算子直接报错（宁可失败也不要静默通过）。 */
function evalPredicate(pred, view, prefix = '') {
  if (Array.isArray(pred)) {
    const fails = [];
    for (const p of pred) {
      const r = evalPredicate(p, view, prefix);
      if (!r.pass) fails.push(r.message);
    }
    return { pass: fails.length === 0, message: fails.join('；') };
  }
  if (!pred || typeof pred !== 'object') return { pass: false, message: '谓词必须是对象或数组' };
  if (pred.all !== undefined) {
    const r = evalPredicate(pred.all, view, prefix);
    return { pass: r.pass, message: r.message ? 'all 未全满足：' + r.message : '' };
  }
  if (pred.any !== undefined) {
    const list = asArray(pred.any);
    const msgs = [];
    for (const p of list) {
      const r = evalPredicate(p, view, prefix);
      if (r.pass) return { pass: true, message: '' };
      msgs.push(r.message);
    }
    return { pass: false, message: 'any 无一满足：' + msgs.join('；') };
  }
  if (pred.not !== undefined) {
    const r = evalPredicate(pred.not, view, prefix);
    return { pass: !r.pass, message: r.pass ? `not 意外成立：${prefix}${pred.not.path || ''}` : '' };
  }

  const path = pred.path;
  const actual = readPath(view, path);
  const label = `${prefix}${path}`;
  const show = (v) => { try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); } };

  for (const k of Object.keys(pred)) {
    if (k === 'path' || k === 'message') continue;
    if (k === 'exists') {
      const want = pred.exists !== false;
      const has = actual !== undefined;
      if (has !== want) return { pass: false, message: `${label} ${want ? '不存在' : '却存在'}（实际 ${show(actual)}）` };
      continue;
    }
    if (k === 'eq' || k === 'ne') {
      const same = deepEqual(actual, pred[k]);
      if (k === 'eq' && !same) return { pass: false, message: `${label} 应为 ${show(pred[k])}，实际 ${show(actual)}` };
      if (k === 'ne' && same) return { pass: false, message: `${label} 不应等于 ${show(pred[k])}` };
      continue;
    }
    if (NUM_OPS[k]) {
      if (typeof actual !== 'number') return { pass: false, message: `${label} 不是数字（${show(actual)}），无法比较` };
      if (!NUM_OPS[k](actual, pred[k])) return { pass: false, message: `${label} 应 ${k} ${pred[k]}，实际 ${actual}` };
      continue;
    }
    if (k === 'match') {
      let re;
      try { re = pred[k] instanceof RegExp ? pred[k] : new RegExp(String(pred[k])); }
      catch (e) { throw new Error(`expect.match 正则非法：${pred[k]}`); }
      if (typeof actual !== 'string' || !re.test(actual)) return { pass: false, message: `${label} 不匹配 ${re}（实际 ${show(actual)}）` };
      continue;
    }
    if (k === 'includes') {
      const ok = typeof actual === 'string'
        ? actual.includes(String(pred[k]))
        : Array.isArray(actual) ? actual.some((x) => deepEqual(x, pred[k])) : false;
      if (!ok) return { pass: false, message: `${label} 不包含 ${show(pred[k])}（实际 ${show(actual)}）` };
      continue;
    }
    if (k === 'type') {
      if (typeOf(actual) !== String(pred[k])) return { pass: false, message: `${label} 类型应为 ${pred[k]}，实际 ${typeOf(actual)}` };
      continue;
    }
    throw new Error(`expect 未知算子：${k}（可用 eq/ne/gt/gte/lt/lte/match/includes/exists/type/all/any/not）`);
  }
  return { pass: true, message: '' };
}

function normWrite(w) { return { kind: w.kind, op: w.op, nodeId: w.nodeId, args: w.args, desc: w.desc }; }

/* 种子实体：{ entityId: { state, attributes, friendly_name } } 或 { state } 简写。
 * used = 脚本实际读过/写过（getState / listEntities 命中 / callService 回写 / MCP 注入）；
 * 快照默认只回 used，避免把种子里几十个背景实体全塞给 AI（entityScope:'all' 可要全量）。 */
function seedEntities(seed) {
  const map = new Map();
  const src = (seed && seed.entities) || {};
  for (const [eid, val] of Object.entries(src)) {
    const o = val == null ? {} : val;
    map.set(String(eid), {
      state: o.state == null ? null : o.state,
      attributes: clone(o.attributes || {}),
      friendly_name: o.friendly_name,
      touched: false,
      used: false,
    });
  }
  return map;
}

function createSimSession({ scriptId, startAt, seed, dispatch, onControlLog, clock: sharedClock }) {
  const sid = String(scriptId || '');
  /* 必须与被注入 createCore 的时钟是同一个实例：脚本的 hold/after/sleep 定时器在 core 侧排，
   * advance/snapshot 在 session 侧驱动——两个实例会让快进推不动任何定时器。 */
  const clock = sharedClock || new VirtualClock({ startAt });
  /* 初始种子原样留一份：sim_export 要把它写成可复跑的 fixture（世界里的表已经被脚本改过）。 */
  const initialSeed = {
    entities: clone((seed && seed.entities) || {}),
    context: clone((seed && seed.context) || {}),
  };
  const world = {
    scriptId: sid,
    clock,
    entities: seedEntities(seed),
    initialSeed,
    context: {
      global: clone((seed && seed.context && seed.context.global) || {}),
      local: clone((seed && seed.context && seed.context.local) || {}),
    },
    tasks: new Map(),          // scriptId -> { state }
    writers: new Map(),        // global key -> writerSid（单写者约定仿真镜像；seed 预置值无写者）
    logs: [],                  // { seq, at, level, message, nodeId }
    writes: [],                // { seq, at, kind, op, desc, nodeId, args }
    tape: [],                  // 驱动步骤流水（inject/advance），sim_export 直接当 steps 用
    marks: new Map(),          // name -> 世界数据快照（时间旅行用）
    assertCursor: 0,           // 上次断言消耗到的 seq（跨调用共享增量基准）
    seq: 0,
    dispatch: (msg) => { if (typeof dispatch === 'function') dispatch(msg); },
    recordWrite,
    onControlLog: (msg) => { if (typeof onControlLog === 'function') onControlLog(msg); },
  };

  function nextSeq() { world.seq += 1; return world.seq; }

  function recordLog(msg) {
    world.logs.push({
      seq: nextSeq(), at: clock.elapsedMs(),
      level: msg.level || 'info', message: String(msg.message || ''),
      nodeId: msg.nodeId ? String(msg.nodeId) : undefined,
    });
  }

  function recordWrite(msg) {
    world.writes.push({
      seq: nextSeq(), at: clock.elapsedMs(),
      kind: msg.kind || 'write', op: String(msg.op || ''),
      desc: msg.desc == null ? '' : String(msg.desc),
      nodeId: msg.nodeId ? String(msg.nodeId) : undefined,
      args: msg.args === undefined ? undefined : clone(msg.args),
    });
  }

  const host = createSimHost(world);

  /* 请求同步/微任务应答：返回 reply 消息，由 worker 桥交给 core.handleMessage。 */
  function request(msg) {
    let reply;
    try {
      const result = host.handle(msg.action, msg.data);
      reply = { type: 'reply', id: msg.id, ok: true, result };
    } catch (e) {
      reply = { type: 'reply', id: msg.id, ok: false, error: e && e.message || String(e) };
    }
    return reply;
  }

  /* 注入：先改虚拟世界，再把 state/contextChange/contextWriterState/suspend 派发给 core（§3.2）。 */
  function inject(payload) {
    const p = payload || {};
    const applied = [];
    if (p.entity) {
      const eid = String(p.entity.entityId == null ? '' : p.entity.entityId);
      const ent = world.entities.get(eid) || { state: null, attributes: {}, touched: false, used: false };
      const prev = { state: ent.state, attributes: ent.attributes || {} };
      if (p.entity.state !== undefined) ent.state = p.entity.state;
      if (p.entity.attributes !== undefined) ent.attributes = clone(p.entity.attributes) || {};
      if (p.entity.friendly_name !== undefined) ent.friendly_name = p.entity.friendly_name;
      ent.touched = true;
      ent.used = true;
      world.entities.set(eid, ent);
      world.dispatch({ type: 'state', entityId: eid, state: { state: ent.state, attributes: ent.attributes || {} }, prev });
      applied.push({ kind: 'entity', entityId: eid });
      world.tape.push({
        op: 'inject_entity', entityId: eid, state: ent.state,
        ...(p.entity.attributes !== undefined ? { attributes: clone(ent.attributes) } : {}),
        ...(p.entity.friendly_name !== undefined ? { friendly_name: ent.friendly_name } : {}),
      });
    }
    if (p.context) {
      const scope = p.context.scope === 'global' ? 'global' : 'local';
      const bucket = world.context[scope] || (world.context[scope] = {});
      const prev = Object.prototype.hasOwnProperty.call(bucket, p.context.key) ? bucket[p.context.key] : null;
      bucket[p.context.key] = clone(p.context.value);
      /* writer：为该 key 盖写者章（与真实单写者约定对齐）——盖了章的 key，
       * inject_task 改写者状态时会折叠派发 contextWriterState。缺省无写者（不派发）。 */
      const writer = scope === 'global' && p.context.writer ? String(p.context.writer) : null;
      if (writer) world.writers.set(p.context.key, writer);
      if (scope === 'global') {
        world.dispatch({ type: 'contextChange', scope: 'global', key: p.context.key, value: bucket[p.context.key], prev, writerSid: writer || '', namespace: 'simulation' });
      } else {
        /* local 私有桶：仿真注入是唯一外部写入源，dispatch 回 runner 的 local.watch；
         * 真实执行器 local 写入不发事件（runner 内闭环），因此这里只补仿真路径。 */
        world.dispatch({ type: 'contextChange', scope: 'local', key: p.context.key, value: bucket[p.context.key], prev, namespace: 'simulation' });
      }
      applied.push({ kind: 'context', scope, key: p.context.key });
      world.tape.push({ op: 'inject_context', scope, key: p.context.key, value: clone(p.context.value), ...(writer ? { writer } : {}) });
    }
    if (p.task) {
      const tid = String(p.task.scriptId || '');
      const tstate = String(p.task.state || 'stopped');
      world.tasks.set(tid, { state: tstate });
      /* 写者状态折叠：该脚本写过的 global key 同步派发 contextWriterState（与真实执行器
       * notifyCtxWriterState 同构——runner 侧防抖后进同一回调）。taskState 直派已随
       * ctx.task.watch 删除：订阅类状态通知统一走写者折叠通道。 */
      for (const [k, wSid] of world.writers) {
        if (wSid !== tid) continue;
        const gbucket = world.context.global || {};
        const wvalue = Object.prototype.hasOwnProperty.call(gbucket, k) ? clone(gbucket[k]) : null;
        world.dispatch({ type: 'contextWriterState', scope: 'global', key: k, value: wvalue, prev: wvalue, scriptId: tid, state: tstate, namespace: 'simulation', reason: 'simulation' });
      }
      applied.push({ kind: 'task', scriptId: tid });
      world.tape.push({ op: 'inject_task', scriptId: tid, state: tstate });
    }
    if (p.suspend !== undefined) {
      world.dispatch({ type: p.suspend ? 'suspend' : 'resume', reason: 'simulation' });
      applied.push({ kind: 'suspend', value: !!p.suspend });
      world.tape.push({ op: 'inject_suspend', suspend: !!p.suspend });
    }
    if (p.params !== undefined) {
      applied.push({ kind: 'params', value: clone(p.params) });
      /* params 只在 run 时由 meta 注入；运行中注入记入快照供 AI 观察，不改已启动脚本。 */
      world.onControlLog({ type: 'log', level: 'warn', message: '仿真注入 params 仅在下一次进入 simulate 时生效' });
    }
    return { ok: true, applied, clockNow: clock.iso(), at: clock.elapsedMs() };
  }

  function advance(ms) {
    world.tape.push({ op: 'advance', ms: Math.max(0, Number(ms) || 0) });
    return clock.advance(ms);
  }

  /* ---- 时间旅行（P2）：只回滚「输入世界」，不回滚时钟与脚本内部状态 ----
   * 用途：同一段脚本逻辑要从不同输入分支再跑一次时，不必重开会话。
   * 明确边界：定时器、keepAlive、已执行过的续体都不会倒退——需要完全重放请用 sim_run_steps 重建。 */
  function mark(name) {
    /* 自动名要防撞：手动建过 m1/m2 之后，size+1 可能撞上已有名字并静默覆盖（实测踩过）。 */
    let key = String(name || '');
    if (!key) {
      let n = world.marks.size + 1;
      while (world.marks.has(`m${n}`)) n += 1;
      key = `m${n}`;
    }
    const snapshotData = {
      at: clock.elapsedMs(), seq: world.seq,
      entities: new Map([...world.entities].map(([k, v]) => [k, clone(v)])),
      context: clone(world.context),
      tasks: new Map([...world.tasks].map(([k, v]) => [k, clone(v)])),
    };
    world.marks.set(key, snapshotData);
    return { ok: true, mark: key, at: snapshotData.at, entities: snapshotData.entities.size };
  }

  function rewind(name) {
    const key = String(name || '');
    const m = world.marks.get(key);
    if (!m) throw new Error(`没有这个标记：${key}（先用 mark 建立）`);
    const prev = world.entities;
    world.entities = new Map([...m.entities].map(([k, v]) => {
      const next = clone(v);
      /* used 是「这一段会话里脚本碰过它」的观测标记，不属于世界数据：回滚不该把它抹掉，
       * 否则快照默认口径会突然少掉脚本仍在订阅的实体。 */
      const was = prev.get(k);
      if (was && was.used) next.used = true;
      return [k, next];
    }));
    world.context = clone(m.context);
    world.tasks = new Map([...m.tasks].map(([k, v]) => [k, clone(v)]));
    recordLog({ level: 'warn', message: `[仿真·回滚] 世界数据回到标记 ${key}（at=${m.at}ms；时钟与脚本状态不回退）` });
    return { ok: true, mark: key, at: m.at, clockNow: clock.iso(), clockAt: clock.elapsedMs() };
  }

  /* 单条 assert：按 seq 游标取本段新增 logs/writes 做断言（§7.3 证据层级）。
   * 各字段 AND；writes/noWrites 基于写意图（硬证据），state/context/logs 作辅证。 */
  function assertStep(step, cursor, coreState) {
    const checks = [];
    const name = step.label || step.name || '';
    const newWrites = world.writes.filter((w) => w.seq > cursor);
    const newLogs = world.logs.filter((l) => l.seq > cursor);
    const add = (kind, pass, expected, actual, message) => {
      checks.push({ kind, pass: !!pass, expected: clone(expected), actual: clone(actual), message: message || '' });
    };
    const writeView = (w) => ({ seq: w.seq, at: w.at, kind: w.kind, op: w.op, desc: w.desc, nodeId: w.nodeId, args: w.args });

    if (step.writes !== undefined) {
      const exp = asArray(step.writes);
      const pass = exp.length === newWrites.length && exp.every((e, i) => matchWrite(e, newWrites[i]));
      add('writes', pass, exp, newWrites.map(writeView),
        pass ? '' : `写意图序列不符：期望 ${exp.length} 条，实际 ${newWrites.length} 条`);
    }
    if (step.noWrites !== undefined) {
      const banned = step.noWrites === true ? null : asArray(step.noWrites).map(String);
      const hits = banned === null ? newWrites : newWrites.filter((w) => banned.includes(String(w.op)));
      add('noWrites', hits.length === 0, step.noWrites, hits.map((w) => w.op),
        hits.length ? `出现禁止的写意图：${hits.map((w) => w.op).join(', ')}` : '');
    }
    if (step.state !== undefined) {
      for (const s of asArray(step.state)) {
        const eid = String(s && s.entityId != null ? s.entityId : '');
        const ent = world.entities.get(eid);
        let pass = !!ent;
        if (pass && s.state !== undefined) pass = ent.state === s.state || String(ent.state) === String(s.state);
        if (pass && s.attributes !== undefined) pass = deepEqual(s.attributes, ent.attributes || {});
        add('state', pass, s, ent ? { state: ent.state, attributes: ent.attributes } : null,
          `${eid} 终值${pass ? '符合' : '不符'}`);
      }
    }
    if (step.context !== undefined) {
      for (const c of asArray(step.context)) {
        const scope = c && c.scope === 'local' ? 'local' : 'global';
        const bucket = world.context[scope] || {};
        const has = !!(c && Object.prototype.hasOwnProperty.call(bucket, c.key));
        const pass = has && deepEqual(c.value, bucket[c.key]);
        add('context', pass, c, has ? bucket[c.key] : undefined,
          `${scope}.${c && c.key}${pass ? '符合' : '不符'}`);
      }
    }
    if (step.logs !== undefined) {
      for (const e of asArray(step.logs)) {
        const matches = (l) => {
          if (typeof e === 'string') return l.message.includes(e);
          if (!e || typeof e !== 'object') return false;
          return (e.level === undefined || l.level === e.level)
            && (e.message === undefined || l.message.includes(String(e.message)));
        };
        const hits = newLogs.filter(matches);
        add('logs', hits.length > 0, e, hits.map((l) => l.message),
          `日志 ${typeof e === 'string' ? e : JSON.stringify(e)} ${hits.length ? '出现' : '未出现'}`);
      }
    }
    /* DSL：任意路径断言。writes/logs 走同一增量基准，其余字段看当前世界全量。 */
    if (step.expect !== undefined) {
      const full = snapshot({ coreState, entityScope: 'all' });
      const view = {
        ...full,
        writes: newWrites.map(writeView),
        logs: newLogs.map(clone),
        allWrites: full.writes,
        allLogs: full.logs,
        tasks: Object.fromEntries([...world.tasks].map(([k, v]) => [k, clone(v)])),
      };
      const verdict = evalPredicate(step.expect, view);
      const seen = [];
      (function collect(p) {
        if (Array.isArray(p)) { p.forEach(collect); return; }
        if (!p || typeof p !== 'object') return;
        if (p.all !== undefined) return collect(p.all);
        if (p.any !== undefined) return collect(p.any);
        if (p.not !== undefined) return collect(p.not);
        if (p.path) seen.push({ path: p.path, actual: clone(readPath(view, p.path)) });
      })(step.expect);
      add('expect', verdict.pass, step.expect, seen, verdict.message);
    }
    return { name, passed: checks.length > 0 && checks.every((c) => c.pass), checks };
  }

  /* 批量用例执行（§7.4）：顺序跑 steps，逐步断言，一次返回全部结果。
   * 断言基准 = 自上次 assert 以来的新增（seq 游标），与 §7.2 since 同语义。
   * 断言失败默认不中断（收集全部失败点）；step 执行异常中断；failFast 可选。 */
  async function runSteps(steps, opts = {}) {
    const list = Array.isArray(steps) ? steps : [];
    const coreState = typeof opts.coreState === 'function' ? opts.coreState : () => ({});
    const failFast = opts.failFast === true;
    const results = [];
    let cursor = world.assertCursor;   // 跨调用共享：上一次 sim_assert / assert 消耗到哪
    let executed = 0;                  // 已尝试执行的步数（含执行失败的那步，见循环内自增时机）
    const fromAt = clock.elapsedMs();

    for (let i = 0; i < list.length; i += 1) {
      const step = list[i] || {};
      const op = String(step.op || '');
      const rec = { index: i, op };
      executed += 1; // 无论成败都算"跑过"：失败步不出现在 executed 会让进度统计说谎
      try {
        switch (op) {
          case 'advance': {
            /* 走 advance() 包装而不是 clock.advance()：包装里会 push 到 tape，
             * 否则用 run_steps 驱动的会话导出成 fixture 时会丢掉所有推进步骤，
             * 重放时时钟不动、定时器不触发，写意图全空（真实用例踩到过）。 */
            const r = await advance(step.ms);
            rec.advanced = r.advanced; rec.at = r.now; rec.fired = r.fired.length;
            break;
          }
          case 'inject_entity':
            rec.applied = inject({ entity: {
              entityId: step.entityId, state: step.state,
              attributes: step.attributes, friendly_name: step.friendly_name,
            } }).applied;
            break;
          case 'inject_context':
            /* writer 必须透传：fixture 用例靠它盖写者章，丢了写者折叠（writerState 派发）
             * 在重放里永远验不了（与 MCP sim_inject 单步注入的 inject 路径同口径）。 */
            rec.applied = inject({ context: { scope: step.scope, key: step.key, value: step.value, writer: step.writer } }).applied;
            break;
          case 'inject_task':
            rec.applied = inject({ task: { scriptId: step.scriptId, state: step.state } }).applied;
            break;
          case 'inject_suspend':
            rec.applied = inject({ suspend: step.suspend === undefined ? true : step.suspend }).applied;
            break;
          case 'inject_params':
            rec.applied = inject({ params: step.params }).applied;
            break;
          case 'snapshot':
            rec.snapshot = snapshot({ coreState, since: step.since, include: step.include, entityScope: step.entityScope });
            break;
          case 'mark':
            rec.mark = mark(step.name || step.mark);
            break;
          case 'rewind':
            rec.rewind = rewind(step.mark || step.name);
            break;
          case 'assert': {
            /* since 可覆盖本次断言的增量基准（如 since:0 = 全序列），不影响后续步的游标推进。 */
            const useCursor = step.since === undefined ? cursor : Math.max(0, Number(step.since) || 0);
            const verdict = assertStep(step, useCursor, coreState);
            rec.label = verdict.name;
            rec.passed = verdict.passed;
            rec.checks = verdict.checks;
            rec.failed = verdict.checks.filter((c) => !c.pass);
            break;
          }
          default:
            throw new Error('未知的 step op：' + op);
        }
        await drain();
        rec.ok = true;
      } catch (e) {
        rec.ok = false;
        rec.error = (e && e.message) || String(e);
        results.push(rec);
        break;
      }
      results.push(rec);
      if (op === 'assert') { cursor = world.seq; world.assertCursor = cursor; } // 断言消耗本段增量
      if (failFast && Array.isArray(rec.failed) && rec.failed.length) break;
    }

    const asserts = results.filter((r) => r.op === 'assert');
    return {
      ok: results.every((r) => r.ok !== false) && asserts.every((a) => a.passed === true),
      total: asserts.length,
      passed: asserts.filter((a) => a.passed === true).length,
      failed: asserts.filter((a) => a.passed === false).length,
      executed,
      aborted: results.length > 0 && results[results.length - 1].ok === false,
      fromAt,
      results,
      final: snapshot({ coreState }),
    };
  }

  /* 交互式断言（P2 sim_assert）：对当前会话做一次断言，基准与 run_steps 的 assert 相同
   * （默认自上次断言以来新增，可用 since 指定），返回 checks 供 AI 直接读。 */
  function assertNow(step, opts = {}) {
    const coreState = typeof opts.coreState === 'function' ? opts.coreState : () => ({});
    const cursor = opts.since === undefined ? world.assertCursor : (Number(opts.since) || 0);
    const verdict = assertStep(step || {}, cursor, coreState);
    world.assertCursor = world.seq;
    return {
      ok: verdict.passed, label: verdict.name || null,
      at: clock.elapsedMs(), seq: world.seq, checks: verdict.checks,
      failed: verdict.checks.filter((c) => !c.pass),
    };
  }

  /* 导出用例（P2 sim_export）：起始时刻 + 初始种子 + 驱动流水（tape） + 观测到的写意图。
   * tape 只含 inject/advance（不含断言/快照），所以导出的 fixture 能原样重放。 */
  function exportCase() {
    return {
      scriptId: sid,
      startAt: new Date(clock.startEpoch).toISOString(),
      seed: clone(initialSeed),
      steps: clone(world.tape),
      expected: { writes: world.writes.map(normWrite) },
      observed: { writes: world.writes.length, logs: world.logs.length, at: clock.elapsedMs(), seq: world.seq },
    };
  }

  /* 快照：同步拉取，两个 advance 之间世界静止，不会漏事件（§7.2/§7.6）。 */
  function snapshot(opts) {
    const o = opts || {};
    const since = Number(o.since) || 0;
    const include = Array.isArray(o.include) ? o.include : null;
    const want = (k) => !include || include.includes(k);
    const coreState = typeof o.coreState === 'function' ? o.coreState() : {};
    const snap = {
      scriptId: sid,
      verifyMode: 'simulate',
      clockNow: clock.iso(),
      at: clock.elapsedMs(),
      seq: world.seq,
    };
    if (want('logs')) snap.logs = world.logs.filter((x) => x.seq > since).map(clone);
    if (want('writes')) snap.writes = world.writes.filter((x) => x.seq > since).map(clone);
    if (want('entities')) {
      /* 默认只回「脚本用过」的实体（读/写/注入），全量要显式 entityScope:'all'。 */
      const scope = o.entityScope === 'all' ? 'all' : 'used';
      const ents = {};
      for (const [eid, ent] of world.entities) {
        if (scope === 'used' && !ent.used) continue;
        ents[eid] = {
          state: ent.state, attributes: clone(ent.attributes || {}),
          touched: !!ent.touched, used: !!ent.used,
          ...(ent.friendly_name !== undefined ? { friendly_name: ent.friendly_name } : {}),
        };
      }
      snap.entities = ents;
      snap.entityScope = scope;
    }
    if (want('context')) snap.context = clone(world.context);
    if (want('stats')) snap.stats = coreState.stats || { intent: 0, sent: 0, blocked: 0 };
    if (want('execution')) {
      const exec = { ...(coreState.execution || { state: 'idle', runCount: 0 }) };
      /* core 不跟踪 nodeId/异常文案：从会话日志反查最近一条带 nodeId 与最近一条 error。 */
      let lastNodeId = null;
      let lastError = null;
      for (const l of world.logs) {
        if (l.nodeId) lastNodeId = l.nodeId;
        if (l.level === 'error') lastError = l.message;
      }
      exec.lastNodeId = lastNodeId;
      exec.lastError = lastError;
      snap.execution = exec;
    }
    if (want('timers')) snap.timers = clock.timerList();
    if (want('watchers')) snap.watchers = coreState.watchers || [];
    return snap;
  }

  function destroy() { clock.destroy(); }

  return {
    clock, request, inject, advance, runSteps, snapshot, destroy,
    recordLog, recordWrite, assertNow, mark, rewind, exportCase,
  };
}

module.exports = { createSimSession };
