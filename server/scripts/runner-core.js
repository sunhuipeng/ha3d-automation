'use strict';
/* runner-core：脚本执行核心（S2 realm 沙箱 + ctx 注入 + 框架 API + 受控定时器）。
 * 三种宿主共用同一套执行语义与消息协议，脚本侧 API 完全一致：
 *   fork    — runner.js 子进程入口：emit 走 IPC；卡死由进程隔离兜底（默认，隔离最硬）。
 *   inline  — inline-runner.js 在主进程内执行（EXECUTION_MODE=inprocess）：
 *             单进程省内存；脚本回调经 vm timeout 防同步死循环卡死主进程。
 *   worker  — worker-runner.js 线程入口（EXECUTION_MODE=worker）：
 *             OS 抢占式公平调度 + terminate 强杀异步续体，内存居中。
 *
 * 消息协议：
 *   core → 宿主 : { log | subscribe | contextSubscribe | contextUnsubscribe | request | done }
 *   宿主 → core : { run | reply | state | contextChange | contextWriterState | mode | suspend | resume | stop }
 *
 * 安全边界：AST 白名单（提交时校验）+ realm 沙箱（切断宿主逃逸链）+
 * 脚本层 ctx.write 写闸（影子 / 开发模式）+ 主进程 executor 硬拦截。 */
const vm = require('vm');
const { shadowWrite, devWrite } = require('./log-text');

/* 真实时钟适配器：follow 模式默认走原生定时器/Date，签名与 sim/clock.js 的 VirtualClock 一致。
 * 虚拟化只在 meta.simulate 时由宿主注入 VirtualClock，runner-core 全部时间源统一走 clock。 */
const realClock = {
  isVirtual: false,
  now: () => Date.now(),
  elapsedMs: () => 0,
  date: () => new Date(),
  setTimeout: (fn, ms, ...args) => setTimeout(fn, ms, ...args),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms, ...args) => setInterval(fn, ms, ...args),
  clearInterval: (id) => clearInterval(id),
};

/* 脚本回调（订阅/定时器）同步部分的上限：inline 模式的关键安全措施，
 * 同步死循环会被 V8 timeout 中断，宿主最多卡这段时间而不是永远。
 * 可用 meta.cbTimeoutMs 覆盖（测试加速用）。 */
const CB_TIMEOUT_MS = 2000;

/* hold 的 expect 值等值判定：标量严格相等；对象/数组按 JSON 结构比较。
 * 严格引用比较下，"expect 每次返回结构相同的新对象"会被当成每次都翻转，
 * 计时永远重置、状态永不确认。循环引用等无法序列化的对象回退引用比较。 */
function signalEquals(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch (e) { return false; }
}

function createCore({ emit, clock }) {
  /* emit(msg)：宿主桥。fork 宿主 = process.send；inline 宿主 = EventEmitter。 */
  const clk = clock || realClock;
  let script = '';
  let meta = {};
  let cbTimeoutMs = CB_TIMEOUT_MS;
  let vmCtx = null;               // 当前脚本的 vm context（guarded 回调用）
  /* 运行模式/挂起/停止：由主进程通过 mode/suspend/resume/stop 消息热更新。
   * devMode 由 executor 随 run 注入（全局开发模式），与 dryRun 正交：
   * dryRun=脚本通道身份，devMode=环境写拦截；发布热切只改 dryRun，不改 devMode。 */
  const ctxRuntime = { dryRun: true, devMode: false, stopped: false, suspended: false, suspendReason: null, simulate: false };
  let runActive = false;
  let runCount = 0;
  const writeStats = { intent: 0, sent: 0, blocked: 0 }; // 提到闭包层，供 simState 快照读取
  const subscriptions = new Map(); // entityId -> [cb]
  const globalSubs = new Map();    // ctx.global.watch：key -> Set<cb>（返回取消订阅函数）
  const globalReplay = new Map();  // ctx.global.watch 默认回放：cb -> key（真实事件先到则丢弃回放值）
  const globalWriter = new Map();  // ctx.global.watch 写者缓存：key -> { w, state }（来自注册时 withMeta）
  const writerDebounce = new Map(); // 写者失效防抖：key -> timer（持续 debounceMs 仍非 running 才上报）
  const globalDebounceMs = new Map(); // key -> 防抖时长（首次注册的 opts 定格，默认 5000）
  const localSubs = new Map();     // ctx.local.watch：key -> Set<cb>（脚本私有桶，runner 内闭环，无 IPC 订阅）
  const localReplay = new Map();   // ctx.local.watch 默认回放：cb -> key（真实事件先到则丢弃回放值）
  const timers = new Map();        // ctx.after 定时器：id -> timeout（stop 时统一清理）
  const intervals = new Set();     // sandbox.setInterval 建立的循环定时器（stop 时统一 clear）
  let timerSeq = 0;
  /* 同步等待宿主回执（entity/list 这类要返回值的调用） */
  const waiting = new Map();
  let waitSeq = 0;

  function request(action, data, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const id = ++waitSeq;
      const timer = clk.setTimeout(() => { waiting.delete(id); reject(new Error('runner 请求超时：' + action)); }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      emit({ type: 'request', id, action, data });
    });
  }

  function resolveReply(msg) {
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    clk.clearTimeout(w.timer);
    if (msg.ok) w.resolve(msg.result); else w.reject(new Error(msg.error || '主进程请求失败'));
  }

  /* ctx.task.require 的等待：无订阅唤醒通道（task.watch 已删除、taskState 消息随之下线），
   * 纯靠 ≤200ms 短超时轮询 taskStatus——查询粒度对启动门闩足够，逻辑自包含无竞态窗口。 */

  /* realm 函数受控调用的唯一通道：同步部分受 vm timeout 中断。
   * wantResult=true → await 结果并把异常抛给调用方（hold 的 condition/watcher 用）；
   * wantResult=false → 只管副作用，async 异常记日志，不让 unhandledRejection 漏进宿主。 */
  function callRealm(fn, args, wantResult) {
    const key = wantResult ? '__holdFn' : '__guardFn';
    try {
      vmCtx[key] = fn;
      vmCtx[`${key}Args`] = args || [];
      const r = vm.runInContext(`${key}(...${key}Args)`, vmCtx, { timeout: cbTimeoutMs });
      if (wantResult) return Promise.resolve(r); // thenable 由 Promise.resolve 展开，等价 await
      if (r && typeof r.catch === 'function') {
        r.catch((e) => emit({ type: 'log', level: 'error', message: '异步回调异常：' + (e && e.message || e) }));
      }
    } catch (e) {
      /* 同步超时/异常就地记日志（保持原同步时序，inline 宿主不能延迟一个 microtask）；
       * 取值回调则交给调用方 catch（hold 的 reevaluate 有 catch 与补排）。 */
      if (wantResult) return Promise.reject(e);
      emit({ type: 'log', level: 'error', message: '回调执行被中断（同步超时/异常）：' + (e && e.message || e) });
    }
  }

  /* 副作用回调：异常已在 callRealm 内兜底，绝不冒泡到宿主。 */
  function guardedCall(fn, args) { callRealm(fn, args, false); }

  /* 取值回调：异常留给调用方（hold 的 reevaluate 有 catch 与补排）。 */
  function evalRealm(fn, args) { return callRealm(fn, args, true); }

  /* 退订闭包统一实现：幂等；集合空了再执行 onEmpty（回收 Map 条目 / 通知宿主取消订阅）。 */
  function makeOff(set, cb, onEmpty) {
    let active = true;
    return () => {
      if (!active) return false;
      active = false;
      set.delete(cb);
      if (!set.size && onEmpty) onEmpty();
      return true;
    };
  }

  /* 一次性受控定时器的单一入口：注册表存宿主句柄，对外只返回序号。
   * 回调统一做 stopped 检查（stop 与到点同轮竞态时不得再执行真实写），
   * 并走 guardedCall 防同步死循环。 */
  function scheduleTimer(fn, ms, rest) {
    const id = ++timerSeq;
    const t = clk.setTimeout(() => {
      timers.delete(id);
      if (ctxRuntime.stopped) return;
      guardedCall(fn, rest || []);
    }, Math.max(0, Number(ms) || 0));
    timers.set(id, t);
    return id;
  }
  /* 取消必须先查表拿宿主句柄：直接 clearTimeout(序号) 是 no-op（审计 P0-1）。 */
  function unregisterTimer(id, clearer) {
    const t = timers.get(id);
    if (!t) return false;
    clearer(t);
    timers.delete(id);
    return true;
  }
  const cancelTimer = (id) => unregisterTimer(id, clk.clearTimeout);

  /* ---------------- 沙箱构造（S2 运行层加固）----------------
   * 只把 realm 内对象暴露给脚本：vm context 自带 realm 的 Math/Date/JSON/Promise 等内建，
   * 不再注入宿主版本；ctx/console/timers 这些必须桥接宿主能力的函数，全部转成 realm 内
   * 函数——脚本拿到的是 realm 内函数，其 .constructor 指向 realm Function，拿不到宿主
   * process。宿主实现只存在于 invoke 闭包中，脚本无法访问。
   * 注意：属性遍历在宿主侧做（realm 内 Object.keys 看宿主对象是空的），只把单个函数/值
   * 交给 realm 工厂包装。静态校验已拦 .constructor/.__proto__ 链，这里是第二道纵深。 */
  function buildSandbox() {
    const sandbox = {};
    const context = vm.createContext(sandbox);
    const factory = vm.runInContext(`(invoke) => {
      return {
        makeObject: function () { return {}; },
        wrapFn: function (hostFn) {
          return function (...a) { return invoke(hostFn, a); };
        },
        makePromise: function (executor) { return new Promise(function (res, rej) { executor(res, rej); }); },
        makeError: function (message) { return new Error(message); }
      };
    }`, context);
    const memo = new WeakMap();
    /* 宿主桥：调用宿主函数后，把结果（含 Promise 的 resolve 值）conv 成 realm 安全值，
     * 再用 realm 的 Promise 承载。脚本自始至终拿不到任何宿主对象/函数。 */
    const invoke = (fn, args) => {
      let r;
      try { r = fn(...args); } catch (err) { throw conv(err); } // 同步异常同样 conv：宿主 Error 不得跨 realm
      if (r && typeof r.then === 'function') {
        return tools.makePromise((resolve, reject) => {
          r.then((val) => resolve(conv(val)), (err) => reject(conv(err)));
        });
      }
      return conv(r);
    };
    const tools = factory(invoke);

    /* 宿主对象/函数的可枚举属性统一搬进 realm 对应物：accessor 连 setter 一起搬，
     * 否则 h.value = x 这类回写会落到只有 getter 的 realm 对象上被静默丢弃。
     * 函数身上挂的属性（如 hold 句柄）与对象属性共用一条路径，避免两处漏改。 */
    function copyAccessors(target, src, depth) {
      for (const k of Object.keys(src)) {
        const d = Object.getOwnPropertyDescriptor(src, k);
        if (d && typeof d.get === 'function') {
          const desc = { get: () => conv(d.get.call(src), depth + 1), enumerable: true };
          if (typeof d.set === 'function') desc.set = (nv) => { d.set.call(src, nv); };
          Object.defineProperty(target, k, desc);
        } else {
          target[k] = conv(src[k], depth + 1);
        }
      }
    }

    function conv(v, depth = 0) {
      if (v == null) return v;
      if (depth > 12) return null; // 超深嵌套截断为 null——绝不能把宿主对象原样交给脚本（realm 逃逸）
      const t = typeof v;
      if (t === 'function') {
        if (memo.has(v)) return memo.get(v);
        const w = tools.wrapFn(v);
        memo.set(v, w);
        /* wrapFn 只返回裸函数，不复制自身属性；函数身上挂的属性靠这里搬进 realm */
        copyAccessors(w, v, depth);
        return w;
      }
      if (t !== 'object') return v;
      if (memo.has(v)) return memo.get(v);
      /* Error 的 message/stack 是非枚举属性，Object.keys 拿不到；转成 realm Error 保留 message */
      if (v instanceof Error) {
        const e = tools.makeError(String(v.message || v));
        memo.set(v, e);
        return e;
      }
      const out = tools.makeObject(); // realm 内对象
      memo.set(v, out);
      copyAccessors(out, v, depth); // 只读 getter（dryRun/stopped/suspended）没有 set，行为不变
      return out;
    }
    /* simulate：把 realm 内的 Date 换成虚拟实现，否则脚本自己的 Date.now()/new Date()
     * 与 hold 的虚拟时钟对不上。VDate 是 realm 内类，只通过 conv 包过的 nowFn 回调宿主
     * 时钟（拿到的是数字，realm 安全），拿不到宿主逃逸链。follow 模式不注入，保持原生。 */
    if (clk.isVirtual) {
      const makeVDate = vm.runInContext(`(nowFn) => {
        return class VDate extends Date {
          constructor(...args) { if (args.length === 0) super(nowFn()); else super(...args); }
          static now() { return nowFn(); }
        };
      }`, context);
      /* 必须用箭头闭包转一手：conv 把宿主函数包成 realm 函数后是「裸调用」，
       * 直接丢 clk.now 进去会丢 this（VirtualClock.now 读 this.startEpoch），
       * 脚本一碰 Date.now()/new Date() 就抛 "reading 'startEpoch'"。 */
      sandbox.Date = makeVDate(conv(() => clk.now()));
    }
    return { sandbox, context, conv };
  }

  /* 写者状态折叠的共享实现（api 定义与事件派发两处共用）：
   * fireWriterState：按值变化同款签名回调全部订阅者，value = prev = 当前存量值 */
  function fireWriterState(key, value, sid, state, reason) {
    const set = globalSubs.get(key);
    if (!set || !set.size || ctxRuntime.stopped) return;
    const info = { key, writerSid: sid, namespace: 'production', type: 'writerState', state, reason: reason || '' };
    for (const cb of [...set]) guardedCall(cb, [value, value, info]);
  }
  /* 防抖到点复查：仍非 running 才上报 down；期间恢复（漏收 up 事件）则静默复位 */
  function armWriterDebounce(key) {
    if (writerDebounce.has(key)) return;
    const cached = globalWriter.get(key);
    if (!cached || !cached.w) return; // 写者未知（存量键未重写）无法派发写者状态
    writerDebounce.set(key, clk.setTimeout(async () => {
      writerDebounce.delete(key);
      if (ctxRuntime.stopped) return;
      let st = null;
      try { st = await request('taskStatus', { scriptId: cached.w }); } catch (e) { st = null; }
      if (ctxRuntime.stopped) return;
      if (st && st.state === 'running') { cached.state = 'running'; return; }
      const state = st && st.state ? st.state : 'stopped';
      cached.state = state;
      let value;
      try { value = await request('contextGet', { scope: 'global', key }); } catch (e) { value = undefined; }
      fireWriterState(key, value === undefined ? null : value, cached.w, state, 'debounced');
    }, globalDebounceMs.get(key) || 5000));
  }

  function contextApi(scope) {
    const api = {
      get: (key, fallback) => request('contextGet', { scope, key, default: fallback }),
      set: (key, value) => request('contextSet', { scope, key, value }),
    };
    /* ctx.local：脚本私有桶（按 sid:通道 隔离），产生与消费都在同一 runner 内——
     * watch 完全在 runner 内部闭环：set 写完后就地派发，不走 IPC 订阅表、
     * 不盖写者章、无写者健康折叠、无防抖。读侧仍走宿主（仿真/落盘一致）。 */
    if (scope === 'local') {
      api.set = async (key, value) => {
        const k = String(key == null ? '' : key);
        const watched = localSubs.get(k);
        /* 写前取旧值：只为给 watcher 一个准确的 prev；无订阅者不付这次 IPC 开销 */
        const prev = (watched && watched.size) ? await request('contextGet', { scope: 'local', key: k }) : undefined;
        const result = await request('contextSet', { scope, key, value });
        if (watched && watched.size && !ctxRuntime.stopped && !signalEquals(prev, value)) {
          dispatchLocalChange({ key: k, value, prev: prev === undefined ? null : prev, source: 'set' });
        }
        return result;
      };
      /* ctx.local.watch(key, cb)：默认回放——桶有值立即回调一次（prev=null、source='replay'），
       * 桶无值不回放；真实事件先到则丢弃在途回放值。回调 (value, prev, info)，
       * info = { key, scope:'local', source:'set'|'replay' }。返回 off()（幂等）。 */
      api.watch = (key, cb) => {
        const k = String(key == null ? '' : key);
        if (!k || typeof cb !== 'function') throw new Error('ctx.local.watch 需要 key 与回调函数');
        let set = localSubs.get(k);
        if (!set) { set = new Set(); localSubs.set(k, set); }
        set.add(cb);
        localReplay.set(cb, k);
        request('contextGet', { scope: 'local', key: k }).then((v) => {
          if (ctxRuntime.stopped) return;
          if (localReplay.get(cb) !== k) return;  // 真实事件先到，丢弃回放
          localReplay.delete(cb);
          if (v === undefined) return;            // 桶无值：不回放
          if (!set.has(cb)) return;               // 已 off
          guardedCall(cb, [v, null, { key: k, scope: 'local', source: 'replay' }]);
        }).catch(() => localReplay.delete(cb));
        return makeOff(set, cb, () => {
          localReplay.delete(cb);
          if (!set.size) localSubs.delete(k);
        });
      };
    }
    /* ctx.global.watch(key, cb, opts?)：只订阅 global；local 是脚本私有桶，没有跨脚本变更源。
     * 回调签名 (value, prev, info)。两种事件共用同一签名，靠 info.type 区分：
     *   ① 值变化（type 缺省）：info = { key, writerSid, namespace, source? }；
     *   ② 写者状态（info.type='writerState'）：写者实例状态变化折叠进同一回调，
     *      info = { key, writerSid, namespace, type:'writerState', state, reason }，
     *      value = prev = 当前存量值（旧消费者当作"值没变的通知"消化，天然兼容）。
     * opts = { debounceMs? }：写者失效防抖——非 running 持续 debounceMs 才上报 down，
     *   恢复 running 立即上报并取消计时（防抖计时走虚拟时钟，仿真 advance 可推动）；
     *   首次注册的 opts 定格该 key 的时长（多回调共享一个 key 通道），缺省 5000。
     * 回放：注册即拉 {v, w, ws}——桶有值立即按值变化回调一次（prev=null、source='replay'，
     *   writerSid=存储的真实写者）；写者当前非 running 同样过防抖后才上报（注册即复查）。
     * 桶无值不回放（fallback 场景留给 ctx.global.get）；真实事件先到则丢弃回放值。 */
    if (scope === 'global') {
      api.watch = (key, cb, opts) => {
        const k = String(key == null ? '' : key);
        if (!k || typeof cb !== 'function') throw new Error('ctx.global.watch 需要 key 与回调函数');
        let set = globalSubs.get(k);
        if (!set) { set = new Set(); globalSubs.set(k, set); }
        const first = set.size === 0;
        set.add(cb);
        if (first && opts && opts.debounceMs !== undefined) {
          const ms = Number(opts.debounceMs);
          if (Number.isFinite(ms) && ms >= 0) globalDebounceMs.set(k, ms);
        }
        if (first) emit({ type: 'contextSubscribe', scope: 'global', key: k });
        globalReplay.set(cb, k);
        request('contextGet', { scope: 'global', key: k, withMeta: true }).then((meta) => {
          if (ctxRuntime.stopped) return;
          const m = meta && typeof meta === 'object' && 'v' in meta ? meta : { v: meta, w: null, ws: null };
          if (first && m.w) {
            globalWriter.set(k, { w: m.w, state: m.ws || 'stopped' });
            if (m.ws && m.ws !== 'running') armWriterDebounce(k); // 注册即失效：同样过防抖
          }
          if (!globalReplay.has(cb) || globalReplay.get(cb) !== k) return;
          globalReplay.delete(cb);
          if (m.v === undefined) return; // 桶无值：不回放
          if (!set.has(cb)) return;      // 已 off
          guardedCall(cb, [m.v, null, { key: k, writerSid: m.w || '', namespace: 'production', source: 'replay' }]);
        }).catch(() => globalReplay.delete(cb));
        return makeOff(set, cb, () => {
          globalReplay.delete(cb);
          if (!set.size) {
            globalSubs.delete(k);
            globalWriter.delete(k);
            globalDebounceMs.delete(k);
            const t = writerDebounce.get(k);
            if (t) { clk.clearTimeout(t); writerDebounce.delete(k); }
            emit({ type: 'contextUnsubscribe', scope: 'global', key: k });
          }
        });
      };
    }
    return api;
  }

  async function run() {
    ctxRuntime.dryRun = meta.dryRun !== false;
    ctxRuntime.devMode = meta.devMode === true;
    /* 仿真是运行态属性，不写版本、不进 meta 身份：runner 收到 meta.simulate 才置位。
     * dryRun 保持 true（影子身份），写闸靠 ctxRuntime.simulate 独立放行。 */
    ctxRuntime.simulate = clk.isVirtual === true && meta.simulate === true;
    cbTimeoutMs = Math.max(50, Number(meta.cbTimeoutMs) || CB_TIMEOUT_MS);

    /* ---------------- 框架层通用能力 ----------------
     * 只放“每个脚本都会重复写一遍、且与业务无关”的样板；
     * 判据（阈值、模式识别）和具体动作语义必须留在脚本里。 */
    /* ctx.task：查询/等待其他脚本实例状态。状态裁决（只看依赖的**正式实例**，影子实例
     * 不参与——mode 恒 production、读不隔离）全在主进程 executor 完成，脚本侧只消费结果，
     * 避免各处重复实现通道规则。 */
    const taskStatus = (id) => request('taskStatus', { scriptId: String(id == null ? '' : id) });
    const taskRequire = async (id, opts = {}) => {
      const sid = String(id == null ? '' : id);
      if (!sid) throw new Error('ctx.task.require 需要脚本 id');
      const raw = Number(opts && opts.timeout);
      const timeoutMs = opts && opts.timeout !== undefined && Number.isFinite(raw) && raw >= 0 ? raw : 30000;
      const deadline = clk.now() + timeoutMs;
      let last = null;
      for (;;) {
        if (ctxRuntime.stopped) throw new Error(`脚本已停止，取消等待依赖 ${sid}`);
        last = await request('taskStatus', { scriptId: sid });
        if (last && last.state === 'running') return last; // 一次性门闩：首次 running 后不再阻断
        const left = deadline - clk.now();
        if (left <= 0) throw new Error(`等待依赖脚本 ${sid} 超时（${timeoutMs}ms，当前状态：${last && last.state || 'unknown'}）`);
        await new Promise((r) => clk.setTimeout(r, Math.min(200, left)));
      }
    };

    /* ctx.task.watch 已删除（2026-11-28）：单写者约定下，依赖脚本的健康监控由
     * ctx.global.watch 的写者状态折叠统一承载（写者失效折叠派发进它写过的 key 的
     * 同一回调通道，防抖内建）。task.* 只保留 status（查一次）与 require（等到 running）。 */

    const ctx = {
      scriptId: String(meta.sid || meta.id || ''),
      global: contextApi('global'),
      local: contextApi('local'),
      ha: {
        /* 脚本侧状态接口：entity 取完整实体对象 / state 取 state 字符串 / num 取数字 /
         * attr 取单属性 / attrs 取整属性对象 / listEntities 列实体 / change 订阅实体变化。
         * IPC 动作名（getState 等）是主进程与 runner 的内部协议，不对外暴露。 */
        listEntities: (filter) => request('listEntities', { filter }),
        callService: (domain, service, data) => request('callService', { domain, service, data }),
        change: (entityId, cb) => {
          const key = String(entityId || '');
          if (!subscriptions.has(key)) subscriptions.set(key, []);
          subscriptions.get(key).push(cb);
          emit({ type: 'subscribe', entityId: key });
        },
      },
      log: (level, message, nodeId) => emit({ type: 'log', level: String(level || 'info'), message: String(message), nodeId: nodeId ? String(nodeId) : undefined }),
      /* sleep 走 scheduleTimer：登记进 timers 注册表，stop 时由 cleanupLocal 统一清理
       * 并因 stopped 闸不再 resolve 续体——脚本从 await 处安静让步，不产生悬挂续体
       * 继续做副作用（此前裸 setTimeout 不在注册表，stop 后仍会唤醒续体）。 */
      sleep: (ms) => new Promise((resolve) => scheduleTimer(resolve, Math.max(0, Number(ms) || 0))),
      /* 被 ctx.call 触发时携带的入参（主进程注入 meta.callParams）；未被调用时为 null。
       * 由 buildSandbox 的 conv 转成 realm 安全对象，脚本拿不到宿主对象。 */
      params: meta.callParams === undefined ? null : meta.callParams,
      /* 依赖脚本状态（只读原语）：status 查一次；require 一直等到 running（默认 30s 超时）。
       * 订阅类能力已并入 ctx.global.watch 的写者状态折叠通道。 */
      task: { status: taskStatus, require: taskRequire },
      /* 显式联动：触发另一个脚本/场景的正式或影子版本（跟随调用者模式）。
       * 只等"启动回执"，不等被调脚本跑完；目标类型/防重入/防递归全在主进程执行器裁决。 */
      call: (scriptId, params) => {
        let payload;
        try { payload = params === undefined ? undefined : JSON.parse(JSON.stringify(params)); }
        catch (e) { throw new Error('ctx.call 的 params 必须可 JSON 序列化'); }
        return request('callScript', { scriptId: String(scriptId == null ? '' : scriptId), params: payload });
      },
    };

    /* 动作注册表：业务动作仍由脚本定义，框架只负责“影子拦截 + 日志 + 计数” */
    const actionRegistry = new Map();

    ctx.actions = (table) => {
      if (!table || typeof table !== 'object') throw new Error('ctx.actions 需要传入 { name: () => {...} } 对象');
      for (const [name, fn] of Object.entries(table)) {
        if (typeof fn !== 'function') throw new Error(`ctx.actions.${name} 必须是函数`);
        if (actionRegistry.has(name)) throw new Error(`动作重复注册：${name}`);
        actionRegistry.set(name, fn);
      }
    };

    /* ctx.write 是唯一推荐的写入口：影子模式或全局开发模式下只记日志、绝不调用动作。
     * 签名 write(op, desc, nodeId, ...args) 与脚本里原来的本地 write 完全一致。
     * 注意：主进程的硬拦截仍然保留，这里是脚本层的第一道闸，两者都要。 */
    ctx.write = async (op, desc, nodeId, ...args) => {
      const fn = actionRegistry.get(op);
      if (!fn) throw new Error(`未注册的动作：${op}（先调用 ctx.actions({...})）`);
      writeStats.intent += 1;
      /* 停止后不得再下发：stop 只置标志不强杀执行流，已入队的续体仍可能走到这里。 */
      if (ctxRuntime.stopped) {
        writeStats.blocked += 1;
        emit({ type: 'log', level: 'warn', message: `[兜底] 动作已跳过（实例已停止）：${desc}`, nodeId });
        return false;
      }
      /* 兜底：脚本被挂起（HA 断线 / 依赖实体缺失）时不执行任何动作，只记日志。 */
      if (ctxRuntime.suspended) {
        writeStats.blocked += 1;
        emit({ type: 'log', level: 'warn', message: `[兜底] 动作已跳过（${ctxRuntime.suspendReason}）：${desc}`, nodeId });
        return false;
      }
      /* 仿真：身份仍是影子（dryRun=true 不变），但独立的 simulate 标志放行动作执行，
       * 写到虚拟 HA、记写意图。代价是 runner-core 多一个标志判断，收益是脚本完全无法
       * 区分 follow/simulate——验证保真。注意放在 suspended 闸之后、dryRun 闸之前。 */
      if (ctxRuntime.simulate) {
        await fn(...args);
        writeStats.sent += 1;
        emit({
          type: 'simWrite', kind: 'write', op, desc,
          nodeId: nodeId ? String(nodeId) : undefined,
          args: JSON.parse(JSON.stringify(args)), at: clk.elapsedMs(),
        });
        emit({ type: 'log', level: 'warn', message: `[仿真·写意图] ${desc}（action.${op}）`, nodeId });
        return true;
      }
      if (ctxRuntime.dryRun !== false) {
        writeStats.blocked += 1;
        emit({ type: 'log', level: 'warn', message: shadowWrite(desc, op), nodeId });
        return false;
      }
      /* 开发模式：正式通道实例也只记日志不下发（身份仍是正式，上下文仍写正式桶）。 */
      if (ctxRuntime.devMode) {
        writeStats.blocked += 1;
        emit({ type: 'log', level: 'warn', message: devWrite(desc, op), nodeId });
        return false;
      }
      await fn(...args);
      writeStats.sent += 1;
      emit({ type: 'log', level: 'warn', message: `[真实写操作] ${desc}（action.${op}）`, nodeId });
      return true;
    };

    ctx.stats = () => ({ ...writeStats });
    /* 数字转换：保留原语义（非数字 → 0）供明确想当 0 的场合；
     * "读不到"不要靠它，请用 ctx.ha.num 的 fallback 或先 ctx.invalid 判定。 */
    ctx.num = (v) => { const x = Number(v); return Number.isNaN(x) ? 0 : x; };

    /* 统一的"无效状态"判定（实体掉线 / 读不到）：
     * null / undefined / 空串 / 'unavailable' / 'unknown' / 'none' / (number 类型) NaN → true。
     * 刻意不对普通字符串做 Number()：'Busy'/'on' 等合法枚举不能被判无效；
     * 数字语义下"字符串转不出数字"由 ctx.ha.num 自己兜底成 fallback。 */
    const INVALID_STATES = ['unavailable', 'unknown', 'none'];
    ctx.invalid = (v) => {
      if (v == null) return true;
      if (typeof v === 'number') return Number.isNaN(v);
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        return s === '' || INVALID_STATES.includes(s);
      }
      return false;
    };

    /* 读取实体状态的薄封装：state 原样返回字符串（有效性由脚本用 ctx.invalid 自己判）；
     * num 在「实体缺失 / 状态无效 / 非数字」三种情况都返回 fallback，让传入的 null/100 真正兑现。 */
    /* getState 的唯一薄封装：entity / state / num / attr 共用，避免两处口径漂移 */
    const readState = (eid) => request('getState', { entityId: eid });
    ctx.ha.entity = readState;
    ctx.ha.state = async (eid) => { const s = await readState(eid); return s ? s.state : null; };
    ctx.ha.num = async (eid, fallback = 0) => {
      const s = await readState(eid);
      if (!s || ctx.invalid(s.state)) return fallback;
      const x = Number(s.state);
      return Number.isNaN(x) ? fallback : x;
    };
    /* 读取实体属性：空调 hvac_action、input_datetime.timestamp 等触发判据在属性里。
     * attr = 读单个属性；attrs = 读完整 attributes 对象。 */
    ctx.ha.attr = async (eid, key, fallback = null) => {
      const s = await readState(eid);
      if (!s || !s.attributes) return fallback;
      const v = s.attributes[String(key)];
      return v === undefined || v === null ? fallback : v;
    };
    ctx.ha.attrs = async (eid, fallback = null) => {
      const s = await readState(eid);
      if (!s || !s.attributes) return fallback;
      return s.attributes;
    };

    /* 防重入：默认单锁；传 key 可开多把独立锁。上一次未结束则直接返回 false */
    const locks = new Set();
    ctx.lock = async (keyOrFn, maybeFn) => {
      const key = typeof keyOrFn === 'string' ? keyOrFn : 'default';
      const fn = typeof keyOrFn === 'function' ? keyOrFn : maybeFn;
      if (typeof fn !== 'function') throw new Error('ctx.lock 需要回调函数');
      if (locks.has(key)) return false;
      locks.add(key);
      try { await fn(); return true; } finally { locks.delete(key); }
    };

    /* 批量订阅实体变化（转发 ctx.ha.change，签名一致）。
     * ctx.watch 只管 HA 实体；依赖脚本的查/等/订统一在 ctx.task.*（status/require/watch）。 */
    ctx.watch = (entityIds, cb) => {
      const list = Array.isArray(entityIds) ? entityIds : [entityIds];
      for (const eid of list) if (eid) ctx.ha.change(eid, cb);
    };

    /* 时间工具：sod = 当日秒数，与 HA input_datetime 的 timestamp 属性同口径 */
    const pad2 = (x) => String(x).padStart(2, '0');
    const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    ctx.time = {
      today: () => { const d = clk.date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; },
      nowSod: () => { const d = clk.date(); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); },
      weekday: () => WD[clk.date().getDay()],
      nowISO: () => clk.date().toISOString(),
      formatSod: (sod) => {
        const n = Math.max(0, Math.floor(Number(sod) || 0));
        return `${pad2(Math.floor(n / 3600))}:${pad2(Math.floor((n % 3600) / 60))}:${pad2(n % 60)}`;
      },
    };

    /* 可取消延时：对应 HA 的 mode:restart / for: 语义；与裸 setTimeout 共用 scheduleTimer。 */
    ctx.after = (ms, fn) => scheduleTimer(fn, ms);
    ctx.cancel = cancelTimer;

    /* 语义化周期定时：受控 setInterval —— 与 ctx.after 共用 timers 注册表（stop 统一清理、
     * ctx.cancel(id) 可停止）；stopped 后自动注销且不再触发；回调走 guardedCall 防同步死循环。
     * 到点触发优先 ctx.after 一次性重排（无漂移累积）；every 只用于固定频率兜底/清理。 */
    ctx.every = (ms, fn) => {
      const period = Math.max(0, Number(ms) || 0);
      const id = ++timerSeq;
      const t = clk.setInterval(() => {
        if (ctxRuntime.stopped) { unregisterTimer(id, clk.clearInterval); return; }
        guardedCall(fn, []);
      }, period);
      timers.set(id, t);
      return id;
    };

    /* ctx.gate()：合并门——事件驱动评估的忙时合并执行器（每次调用创建独立门）。
     * gate.run(fn)：空闲 → 立即执行 fn，返回 Promise<true>；执行中再调 run → 只保留
     *   最新一次 pending（旧 pending 以"被合并"结束），当前 fn 结束后自动补跑，返回
     *   Promise<false>；stopped → 直接 false 不执行。
     * fn 同步/异步异常均记 error 日志、不向外抛（调用方 fire-and-forget 为主）。
     * 与 ctx.lock 的区别：lock 忙跳过（不排队，适合防重入）；gate 忙合并（不丢最后一次，
     * 适合 watch 回调驱动的评估——事件合并后只回答"现在是什么"，不保证中间序列）。
     * stop / cleanup 时 pending 直接丢弃。 */
    const gateRun = (fn) => Promise.resolve().then(fn).catch((e) => {
      emit({ type: 'log', level: 'error', message: 'gate 执行异常：' + (e && e.message || e) });
    });
    ctx.gate = () => {
      let running = false;
      let pending = null; // { fn }
      const finish = () => {
        if (ctxRuntime.stopped || !pending) { pending = null; running = false; return; }
        const { fn } = pending;
        pending = null;
        gateRun(fn).finally(finish);
      };
      return {
        run(fn) {
          if (typeof fn !== 'function') throw new Error('gate.run 需要回调函数');
          if (ctxRuntime.stopped) return Promise.resolve(false);
          if (running) { pending = { fn }; return Promise.resolve(false); }
          running = true;
          gateRun(fn).finally(finish);
          return Promise.resolve(true);
        },
      };
    };

    /* ctx.ref(初始值?)：脚本内响应式值单元（纯闭包内存，不落盘、不跨脚本）。
     * 用法：const a = ctx.ref(0); a.value = 1; a.watch((v, prev, info) => {...})。
     * 赋值判定：与旧值 signalEquals 相等 → 静默吞掉（标量严格相等，对象/数组按 JSON
     *   结构比较，与 hold 的 expect 判定同款，结构相同的新对象不会误报"变化"）；
     *   不同 → 更新内部值并同步回调全部 watcher（按注册顺序）。
     * watch 回调签名 (value, prev, info)，info = { source: 'set' | 'replay' }；
     *   返回 off() 取消订阅；同一 ref 可多次 watch。
     * 注册是否立即通知：默认**不**——ref 由本脚本自己创建，初始值在创建处已知，
     *   需要"先跑一遍"的消费逻辑请直接读 a.value（或抽成函数手动调一次）；
     *   opts.immediate = true 可显式打开回放（value=当前值、prev=null、source='replay'）。
     * 与 ctx.global.watch 的分工：global.watch 订阅跨脚本共享桶（值变化 + 写者失效
     *   折叠派发，持久化在 data/context.json）；ref 是脚本私有、进程内、重启即失——
     *   只装"只有本脚本读且重启可重算"的运行时状态（存储分层判据的内存档）。
     * stop 后赋值仍更新内部值，但不再触发 watcher（与全局订阅派发一致的停止语义）。 */
    ctx.ref = (initial) => {
      let value = initial === undefined ? null : initial;
      const subs = new Set();
      const notify = (v, prev, info) => {
        for (const cb of [...subs]) guardedCall(cb, [v, prev, info]);
      };
      return {
        get value() { return value; },
        set value(nv) {
          const prev = value;
          if (signalEquals(prev, nv)) return;
          value = nv;
          if (!ctxRuntime.stopped) notify(nv, prev, { source: 'set' });
        },
        watch(cb, opts) {
          if (typeof cb !== 'function') throw new Error('ref.watch 需要回调函数');
          subs.add(cb);
          if (opts && opts.immediate && !ctxRuntime.stopped) {
            guardedCall(cb, [value, null, { source: 'replay' }]);
          }
          return () => { subs.delete(cb); };
        },
      };
    };

    /* ctx.hold：期待值/期待条件的双边迟滞确认器（ref-like 句柄）。
     * 数据流：raw（脚本写入的最新值）→ expect 投影 → desired（是否满足期待，二态）→
     *   desired !== state 时按方向计时（满足=satisfyMs / 不满足=unsatisfyMs）→
     *   持续到点复核仍成立 → state 切换并通知 watcher 一次。
     * watch 回调：(satisfied, prev, info)，satisfied=true 表示"满足期待持续到位"，
     *   false 表示"不满足期待/回落持续到位"。同一状态持续多久都不会重复回调。
     * raw 只由脚本赋值：a.value = x。实体变化由脚本自己 ctx.watch 订阅并在回调里写 raw；
     *   expect 需要读 HA 也可在函数里 await ctx.ha.xxx —— 框架不内置实体监听。
     * 只接受对象参数：{ expect, satisfyMs, unsatisfyMs?, initial?, nodeId?, label? }；
     *   不使用旧语法（数字首参 / ms / condition / fallMs）。unsatisfyMs=null/0/缺省 → 不满足立即回落。
     * 内部状态纯闭包内存，不碰 global/local；stop 时 ctx.after 统一清理。 */
    ctx.hold = (opts) => {
      if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
        throw new Error('ctx.hold 只接受对象参数 { expect, satisfyMs, unsatisfyMs? }');
      }
      const conf = opts;
      const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
      for (const oldKey of ['ms', 'condition', 'fallMs']) {
        if (hasOwn(conf, oldKey)) {
          throw new Error(`ctx.hold 不再支持旧参数 ${oldKey}：请改用 ${oldKey === 'ms' ? 'satisfyMs' : oldKey === 'condition' ? 'expect' : 'unsatisfyMs'}`);
        }
      }
      const satisfyMs = Math.max(0, Number(conf.satisfyMs) || 0);
      if (satisfyMs <= 0) throw new Error('ctx.hold 的满足持续时长 satisfyMs 必须大于 0');

      const unsatisfyRaw = hasOwn(conf, 'unsatisfyMs') ? conf.unsatisfyMs : null;
      const unsatisfyMs = (unsatisfyRaw === null || unsatisfyRaw === undefined || unsatisfyRaw === '')
        ? 0 : Math.max(0, Number(unsatisfyRaw) || 0);

      const initial = conf.initial === undefined ? false : !!conf.initial;
      const expectFn = typeof conf.expect === 'function' ? conf.expect : null;
      const hasExpectValue = !expectFn && hasOwn(conf, 'expect');
      const expectValue = hasExpectValue ? conf.expect : undefined;
      const nodeId = conf.nodeId;
      const label = conf.label ? `[hold·${conf.label}] ` : '[hold] ';
      const log = (message, level = 'info') =>
        emit({ type: 'log', level, message: label + message, nodeId });
      /* 日志文案中文化：只翻显示用的方向/触发标记，info.reason、state().pending 等字段值仍是英文。 */
      const dirCn = (v) => v === 'satisfied' ? '满足' : v === 'unsatisfied' ? '回落' : String(v);
      const trigCn = (v) => String(v).split(':').map((p) => ({
        init: '初始化', assign: '赋值', timer: '到点', retry: '重试', resume: '补排',
      }[p] || dirCn(p))).join('·');

      let raw = initial;
      let state = initial;   // 当前已确认状态：true=已确认满足期待，false=未满足/已回落
      let stable = state;    // 兼容旧 state()/文档：与 state 同步，不再作为 watch 触发条件
      let desired = false;   // 最近一次 expect 投影结果：是否满足期待
      let pending = null;    // 'satisfied' / 'unsatisfied' / null
      let since = 0;         // 当前等待方向开始持续的起点；0 = 未计时
      let timer = null;      // ctx.after 句柄（受 timers 注册表管理，stop 统一清理）
      let seq = 0;           // 重评序号：异步 expect 期间被新一次重评抢占则放弃旧结果
      let dead = false;
      const watchers = new Set();
      const clearHoldTimer = () => { if (timer) { cancelTimer(timer); timer = null; } };
      const delayFor = (direction) => direction === 'satisfied' ? satisfyMs : unsatisfyMs;

      const notify = (trigger, waitedMs) => {
        const prev = state;
        state = desired;
        stable = state;
        pending = null;
        since = 0;
        const reason = state ? 'satisfied' : 'unsatisfied';
        log(`确认${state ? '满足' : '不满足'}：状态 ${String(prev)} → ${String(state)}` +
          `（持续 ${waitedMs}ms，触发=${trigCn(trigger)}）`);
        const info = {
          satisfied: state,
          value: state,
          reason,
          raw,
          expected: desired,
          state,
          stable,
          ms: waitedMs,
          nodeId,
        };
        for (const cb of [...watchers]) {
          evalRealm(cb, [state, prev, info]).catch((e) =>
            log(`watcher 异常：${e && e.message || e}`, 'error'));
        }
      };

      /* 统一到点排程：回调先确认自己仍是当前 timer 再处理（过期回调直接丢弃），
       * 句柄清理也收在这里。到点复核抛异常时保留 pending/since，由异常路径补排重试。 */
      const arm = (delay, trigger) => {
        const id = ctx.after(delay, () => {
          if (timer !== id) return;
          timer = null;
          reevaluate(trigger);
        });
        /* 给虚拟时钟的定时器打标签：快照 timers[] 展示「满足计时/回落计时」，
         * 让 AI 一眼看出脚本此刻在等什么（§7.6）。follow 模式 label 是 no-op。 */
        if (clk.isVirtual && typeof clk.label === 'function') {
          clk.label(id, `${conf.label || 'hold'}·${dirCn(pending || 'satisfied')}计时`);
        }
        timer = id;
      };
      /* 异常重试/句柄补排的间隔：到点后剩余时间为 0 时给 50ms 下限，
       * 避免 expect 连续抛错形成 0ms 紧循环刷日志。 */
      const retryDelay = () => {
        if (!pending) return satisfyMs;
        const delay = delayFor(pending);
        return since > 0 ? Math.max(50, delay - (clk.now() - since)) : Math.max(50, delay);
      };

      async function reevaluate(trigger) {
        if (dead || ctxRuntime.stopped) return;
        const my = ++seq;
        /* 1) 投影 desired：expect 可同步可 async，可自行 await ctx.ha 读实体；
         *    抛错则保守跳过、不推进计时，但必须补排重试。 */
        let next;
        if (expectFn) {
          try { next = !!(await evalRealm(expectFn, [raw])); }
          catch (e) {
            log(`expect 异常，本轮跳过：${e && e.message || e}`, 'error');
            if (my === seq && !dead && !ctxRuntime.stopped && !timer) arm(retryDelay(), 'retry');
            return;
          }
        } else if (hasExpectValue) {
          next = signalEquals(raw, expectValue); // 期待值模式：raw 等于 expect 才算满足
        } else {
          next = !!raw;                          // 默认期待值：truthy 即满足，兼容 a.value=true/'Busy'
        }
        if (my !== seq || dead || ctxRuntime.stopped) return;
        desired = next;

        /* 2) 期待结果与当前已确认状态一致：没有待确认边沿，取消本轮计时，不回调。 */
        if (desired === state) {
          if (pending) log(`期待回到已确认状态 ${String(desired)}，取消${dirCn(pending)}计时`);
          pending = null;
          since = 0;
          clearHoldTimer();
          return;
        }

        /* 3) 期待结果与当前状态相反：按方向计时；中途回到当前状态则上一步会取消。 */
        const direction = desired ? 'satisfied' : 'unsatisfied';
        const delay = delayFor(direction);
        if (pending !== direction) {
          pending = direction;
          since = clk.now();
          clearHoldTimer();
          log(`期待${desired ? '满足' : '不满足'}，${dirCn(direction)}计时 ${delay}ms（触发=${trigCn(trigger)}）`);
          if (delay === 0) { notify(trigger + ':立即', 0); return; }
          arm(delay, trigger);
          return;
        }

        /* 4) 同方向已计时：到点复核仍成立就切换状态并通知一次；句柄丢失则按剩余时间补排。 */
        if (since > 0 && clk.now() - since >= delay) {
          const waitedMs = clk.now() - since;
          clearHoldTimer();
          notify(trigger, waitedMs);
          return;
        }
        if (since > 0 && !timer) arm(Math.max(1, delay - (clk.now() - since)), 'resume');
      }

      const handle = {
        get value() { return state; },
        set value(nv) {
          if (dead) return;
          raw = nv;
          reevaluate('assign');
        },
        watch(cb) {
          if (typeof cb !== 'function') throw new Error('hold.watch 需要回调函数');
          if (dead) return () => false;
          watchers.add(cb);
          return makeOff(watchers, cb);
        },
        cancel() {
          if (dead) return false;
          dead = true;
          seq++;
          clearHoldTimer();
          pending = null;
          since = 0;
          watchers.clear();
          return true;
        },
        state() {
          const active = pending !== null;
          return {
            raw, desired, signal: desired, state, stable: state,
            pending,
            since,
            active,
            remaining: active ? Math.max(0, delayFor(pending) - (clk.now() - since)) : 0,
            ms: satisfyMs,
            satisfyMs,
            unsatisfyMs,
            dead,
          };
        },
      };
      reevaluate('init'); // 首次投影：让初始实体值/expect 立即进入判定
      return handle;
    };

    /* 常驻模式锚点：脚本结尾 await ctx.keepAlive() 让顶层协程永不 resolve，
     * runner 不 emit done、executor 不 cleanup —— 长驻守护脚本的标准结尾。
     * 语义等价于裸 await new Promise(() => {})，但自解释且留一条日志；
     * 一次性任务脚本不调用它，顶层自然结束即正常退出路径。 */
    ctx.keepAlive = () => {
      emit({ type: 'log', level: 'info', message: '脚本进入常驻模式（keepAlive），等待实体推送与定时器' });
      return new Promise(() => {});
    };

    /* 动态 getter：脚本每次读 ctx.dryRun / ctx.stopped / ctx.suspended 都拿当前值，不重启热切换 */
    Object.defineProperty(ctx, 'dryRun', { get: () => ctxRuntime.dryRun, enumerable: true });
    Object.defineProperty(ctx, 'stopped', { get: () => ctxRuntime.stopped, enumerable: true });
    Object.defineProperty(ctx, 'suspended', { get: () => ctxRuntime.suspended, enumerable: true });

    emit({ type: 'log', level: 'info', message: `runner 启动 v${meta.version || '?'}｜模式=${ctxRuntime.dryRun ? '影子' : '正式'}` });
    try {
      const { sandbox, context, conv } = buildSandbox();
      vmCtx = context;
      sandbox.ctx = conv(ctx);
      sandbox.console = conv({
        log: (...a) => emit({ type: 'log', level: 'info', message: a.map(String).join(' ') }),
        error: (...a) => emit({ type: 'log', level: 'error', message: a.map(String).join(' ') }),
      });
      /* 裸 setTimeout 与 ctx.after 共用 scheduleTimer（同一注册表 / stopped 闸 / guardedCall）。
       * 脚本层语义仍与原生一致：返回序号交给 clearTimeout 取消（内部由 cancelTimer 查表）。 */
      sandbox.setTimeout = conv((fn, ms, ...rest) => scheduleTimer(fn, ms, rest));
      sandbox.clearTimeout = conv((id) => { cancelTimer(id); return true; });
      /* setInterval 不直接暴露宿主版本：登记到 intervals 便于 stop 统一清理，
       * 且 stopped 后不再触发回调；回调走 guardedCall 防同步死循环。 */
      sandbox.setInterval = conv((fn, ms, ...rest) => {
        const id = clk.setInterval(() => {
          if (ctxRuntime.stopped) return;
          guardedCall(fn, rest);
        }, Math.max(0, Number(ms) || 0));
        intervals.add(id);
        return id;
      });
      sandbox.clearInterval = conv((id) => { clk.clearInterval(id); intervals.delete(id); return true; });

      /* M10：vm 执行超时从 meta.vmTimeoutMs（主进程按 runnerTimeoutMs 减差值派生）读取 */
      const vmTimeout = Number(meta.vmTimeoutMs) >= 1000 ? Number(meta.vmTimeoutMs) : 55000;
      const wrapped = `(async () => {\n${script}\n})()`;
      const result = vm.runInContext(wrapped, context, { timeout: vmTimeout, filename: 'script.js' });
      await Promise.resolve(result);
      emit({ type: 'log', level: 'info', message: '脚本执行完成' });
      emit({ type: 'done', ok: true });
    } catch (e) {
      /* 异常详情：跨 realm 的 Error 可能既拿不到 message 也 instanceof Array 不成立，
       * 早期只打 e.message 会退化成「脚本异常：[object Object]」，排查等于没有线索。
       * 这里按 message → error → JSON → String 四级降级，并附前几行栈。 */
      const msg = e && (e.message || e.error);
      let raw = '';
      if (!msg) {
        try { raw = ' :: ' + JSON.stringify(e); } catch (err) { raw = ' :: ' + String(e); }
      }
      const stack = e && e.stack ? ' :: ' + String(e.stack).split('\n').slice(0, 3).join(' | ') : '';
      emit({ type: 'log', level: 'error', message: '脚本异常：' + (msg ? String(msg) : String(e)) + raw + stack });
      emit({ type: 'done', ok: false, error: String(msg || e) });
    }
  }

  function dispatchState(eid, state, prev) {
    /* stop 宽限期内主进程已摘订阅，但在途的 state 消息仍可能到达：入口统一挡一道，
     * 与 ctx.write 兜底闸同口径——stopped 后不再触发任何脚本回调。 */
    if (ctxRuntime.stopped) return;
    const key = String(eid || '');
    const cbs = subscriptions.get(key) || [];
    /* 回调签名固定为 (nextObj, prevObj) 完整状态对象，与 ctx.ha.state() 返回字符串不同（契约 §6）。
     * 脚本若要字符串需自行取 s.state，避免误用 s === 'on' 静默失效。
     * guardedCall：同步死循环被 V8 timeout 中断（inline 模式防主进程被卡死的关键）。 */
    for (const cb of cbs) guardedCall(cb, [state, prev]);
  }

  /* ctx.local 的外部写入事件（仿真 inject_context scope=local 经 world.dispatch 回送）：
   * 真实执行器的 local 写入不发 IPC 事件（只有本 runner 自己写、已在 api.set 内派发），
   * 仿真注入是唯一的外部来源——同样清回放、按 key 同步派发本 runner 的订阅者。 */
  function dispatchLocalChange(msg) {
    const key = String(msg.key || '');
    for (const [cb, k] of localReplay) if (k === key) localReplay.delete(cb);
    const cbs = localSubs.get(key);
    if (!cbs || !cbs.size || ctxRuntime.stopped) return;
    const info = { key, scope: 'local', source: msg.source || 'set' };
    for (const cb of [...cbs]) guardedCall(cb, [msg.value, msg.prev, info]);
  }

  function dispatchGlobalChange(msg) {
    if (msg.scope !== 'global') return;
    /* stop 宽限期内订阅虽已从主进程摘除，在途 contextChange 仍可能到达；
     * 入口挡一道，stopped 后 global.watch 的回调（值事件）不再触发。 */
    if (ctxRuntime.stopped) return;
    const key = String(msg.key || '');
    /* 真实变更先到：该 key 上等待回放的订阅以事件为准，丢弃随后到达的回放值 */
    for (const [cb, k] of globalReplay) if (k === key) globalReplay.delete(cb);
    /* 写者章迟到补建：注册时写者未知（存量键在消费者注册前尚未被写 / 仿真 fixture 后盖章），
     * 首个带 writerSid 的值事件据此补建缓存——刚写完的写者必然 running。否则写者失效
     * 防抖永远无从发起（up 事件无缓存也派发、down 事件无缓存静默的不对称）。 */
    if (msg.writerSid && !globalWriter.has(key)) {
      globalWriter.set(key, { w: String(msg.writerSid), state: 'running' });
    }
    const cbs = [...(globalSubs.get(key) || [])];
    const info = { key, writerSid: msg.writerSid || '', namespace: msg.namespace || '' };
    for (const cb of cbs) guardedCall(cb, [msg.value, msg.prev, info]);
  }

  /* 写者状态事件（宿主折叠派发）：running → 立即上报并取消防抖；
   * 非 running → 起/续防抖计时，到点由 armWriterDebounce 复查后上报 */
  function dispatchWriterState(msg) {
    if (msg.scope !== 'global') return;
    if (ctxRuntime.stopped) return;
    const key = String(msg.key || '');
    if (!globalSubs.has(key)) return;
    const cached = globalWriter.get(key);
    const sid = String(msg.scriptId || '');
    if (cached && cached.w && cached.w !== sid) return; // 写者漂移保护（执行器已过滤，双保险）
    const state = String(msg.state || 'stopped');
    if (state === 'running') {
      const t = writerDebounce.get(key);
      if (t) { clk.clearTimeout(t); writerDebounce.delete(key); }
      if (cached) cached.state = 'running';
      fireWriterState(key, msg.value, sid, 'running', msg.reason);
      return;
    }
    if (cached) cached.state = state;
    if (writerDebounce.has(key)) return; // 防抖已在计时，不重复起表
    armWriterDebounce(key);
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'run':
        script = msg.script || '';
        meta = msg.meta || {};
        runCount += 1;
        runActive = true;
        run().finally(() => { runActive = false; });
        return;
      case 'reply':
        resolveReply(msg);
        return;
      case 'state':
        dispatchState(msg.entityId, msg.state, msg.prev);
        return;
      case 'contextChange':
        if (msg.scope === 'local') dispatchLocalChange(msg);
        else dispatchGlobalChange(msg);
        return;
      case 'contextWriterState':
        dispatchWriterState(msg);
        return;
      case 'mode':
        /* 只切换通道身份（dryRun），devMode 是环境属性、发布热切不改变它。 */
        ctxRuntime.dryRun = msg.dryRun !== false;
        emit({
          type: 'log', level: 'warn',
          message: ctxRuntime.dryRun
            ? '⚙ 运行模式切换：影子模式（所有写操作仅记日志）'
            : (ctxRuntime.devMode
              ? '⚙ 运行模式切换：正式通道（开发模式下写操作仍仅记日志）'
              : '⚙ 运行模式切换：正式模式（将真实下发控制）'),
        });
        return;
      /* 兜底挂起/恢复：由主进程在 HA 断线或依赖实体被删时下发。
       * 脚本层 ctx.write 会读 suspended 标志跳过动作；主进程的 HA 写门控是第二道闸。 */
      case 'suspend':
        ctxRuntime.suspended = true;
        ctxRuntime.suspendReason = msg.reason || 'unknown';
        return;
      case 'resume':
        ctxRuntime.suspended = false;
        ctxRuntime.suspendReason = null;
        return;
      case 'stop': {
        ctxRuntime.stopped = true;
        cleanupLocal(); // 订阅/等待者/定时器统一清（与 destroy 同一套，stop 多一条日志）
        emit({ type: 'log', level: 'info', message: '收到停止指令，等待脚本让步退出' });
        /* 不强杀执行流：让长驻脚本在 sleep / 回调后检查 ctx.stopped 布尔属性（不是函数）自行让步退出；
         * 主进程延迟宽限期后会 child.kill() 兜底。 */
        return;
      }
      default:
        return;
    }
  }

  /* stop 的清理体（不含日志）：订阅只对活实例有效、定时器退出后不得再触发写操作。 */
  function cleanupLocal() {
    globalSubs.clear();
    globalReplay.clear(); // 回放请求即使还在途，stopped 后回调前有 stopped 闸
    localSubs.clear();
    localReplay.clear();
    for (const t of writerDebounce.values()) clk.clearTimeout(t);
    writerDebounce.clear();
    globalWriter.clear();
    globalDebounceMs.clear();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    for (const id of intervals) clearInterval(id);
    intervals.clear();
    /* 会话模型（热池）必须项：拒绝仍在等待宿主回执的请求，防止泄漏定时器与悬挂 Promise */
    for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(new Error('实例已结束')); }
    waiting.clear();
  }

  /* 会话终结钩子（热池专用）：session done/被杀后由宿主调用，彻底回收本会话全部
   * 资源——定时器、订阅、等待者、运行时标志。runner-core 的每会话状态全部收敛在
   * createCore 闭包里，destroy 后实例不再被引用即可回收（结构性零跨会话残留）。 */
  function destroy() {
    ctxRuntime.stopped = true;
    cleanupLocal();
  }

  /* 仿真快照的「脚本此刻在等什么」三元组之一（§7.6）：watchers 展开订阅 key，
   * execution 给运行状态/轮次。timers 由 clock.timerList() 提供，logs/writes/entities
   * 由 sim session 提供，宿主侧合并成完整快照。 */
  function simState() {
    const watchers = [];
    for (const key of subscriptions.keys()) watchers.push({ kind: 'entity', key });
    for (const key of globalSubs.keys()) watchers.push({ kind: 'context', scope: 'global', key });
    for (const key of localSubs.keys()) watchers.push({ kind: 'context', scope: 'local', key });
    return {
      execution: { state: runActive ? 'running' : 'idle', lastNodeId: null, runCount, lastError: null },
      watchers,
      stats: { ...writeStats },
      dryRun: ctxRuntime.dryRun, simulate: ctxRuntime.simulate, stopped: ctxRuntime.stopped,
    };
  }

  return { handleMessage, isStopped: () => ctxRuntime.stopped, destroy, simState, ctxRuntime };
}

module.exports = { createCore };
