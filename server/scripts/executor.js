'use strict';
/* 执行器：按 EXECUTION_MODE 三选一宿主（fork 子进程 / inprocess 单进程 / worker 线程），
 * 影子实例强制专属 worker（未验证代码独享线程硬隔离，见 start 内宿主选择注释）。
 * 管理生命周期 / 全局锁 / 看门狗 / 日志。
 * 同一脚本最多 1 正式 + 1 影子实例并行（同槽位互斥）；callService 经 actionLock
 * 做互斥 + 冷却，冲突拒绝不覆盖。 */
const path = require('path');
const { fork } = require('child_process');
const store = require('./store');
const runState = require('./run-state');
const context = require('./context');
const hub = require('../lib/ws-hub');
const { getConfig, DEV_MODE } = require('../config');
const { shadowHa, devHa } = require('./log-text');
const topology = require('./topology');
const { createSimControl } = require('./sim-control');

const RUNNER = path.join(__dirname, 'runner.js');
const { createInlineChild } = require('./inline-runner');
const { createWorkerChild } = require('./worker-child');
const hotPool = require('./hot-pool');
/* 实例表：key = `${scriptId}#v${version}`（不是 scriptId）。
 * 允许同一脚本同时跑**两个**实例：1 个正式（真实下发）+ 1 个影子（只记日志），
 * 互不影响；publish 时收敛成"只剩一个正式实例"。
 * 键格式与 run-state 的 desired-running.json 共享同一实现（inst-key.js），改动一处即全局生效。 */
const { instKey, parseKey } = require('./inst-key');
const running = new Map();      // instKey -> { child, key, sid, version, dryRun, verifyMode, startedAt, restarts }
/* 仿真控制请求回执：requestId -> { resolve, reject, timer }。会话以 scriptId 为键（影子槽位唯一）。 */
const actionLocks = new Map();  // "domain.service.entityId" -> { at, inflight }
const subscriptions = new Map(); // entityId -> Set<child>
/* ctx.global.watch：namespace -> key -> Set<entry>。读侧统一正式命名空间（不隔离），
 * 写侧仍按调用者 dryRun 落桶；脚本消息里的 scope/key 会被校验，namespace 不信任脚本。 */
const ctxWatchers = new Map();
const MAX_CALL_DEPTH = 5;       // ctx.call 调用链深度上限，防 A→B→A 无限递归
let ctxDispatchDepth = 0;       // 同步派发重入保护（inline 模式下回调里再 set 会同步回到这里）
const MAX_CTX_DISPATCH_DEPTH = 8;
let currentConnector = null;   // HA 连接器模块级持有：所有实例的 IPC 回调用同一引用，重启不再丢

function instancesOf(sid) { return [...running.values()].filter((e) => e.sid === String(sid)); }

/* ---------- ctx.global.watch：读统一正式命名空间 + key 精确分发 ----------
 * 事件来自 context.set（内存写入时同步发出）。4 道防护：
 * ① 读不隔离：所有实例（含影子）都只监听 production 桶；影子写入落 shadow 桶，不触发任何回调；
 * ② writerSid 跳过：写者自己不收到回调，避免 set→cb→set 自循环；
 * ③ 同值不发：context.set 里已比较 prev，这里只转发真实变更；
 * ④ 重入上限：inline 模式回调里再写会同步回到这里，超深度直接丢弃。 */
function addCtxWatcher(entry, key) {
  const ns = 'production';
  let keys = ctxWatchers.get(ns);
  if (!keys) { keys = new Map(); ctxWatchers.set(ns, keys); }
  let set = keys.get(key);
  if (!set) { set = new Set(); keys.set(key, set); }
  set.add(entry);
}
function removeCtxWatcher(entry, key) {
  const ns = 'production';
  const keys = ctxWatchers.get(ns);
  if (!keys) return;
  const set = keys.get(key);
  if (!set) return;
  set.delete(entry);
  if (!set.size) keys.delete(key);
  if (!keys.size) ctxWatchers.delete(ns);
}
function onContextChange(evt) {
  if (!evt || evt.scope !== 'global' || ctxDispatchDepth >= MAX_CTX_DISPATCH_DEPTH) return;
  const keys = ctxWatchers.get(evt.namespace);
  if (!keys) return;
  const set = keys.get(evt.key);
  if (!set || !set.size) return;
  ctxDispatchDepth += 1;
  try {
    for (const entry of [...set]) {
      if (entry.sid === evt.writerSid) continue; // 写者不通知自己
      try {
        entry.child.send({
          type: 'contextChange', scope: 'global', key: evt.key,
          value: evt.value, prev: evt.prev, writerSid: evt.writerSid, namespace: evt.namespace,
        });
      } catch (e) {}
    }
  } finally { ctxDispatchDepth -= 1; }
}
context.onChange(onContextChange);

/* ---------- 兜底：脚本引用实体跟踪 + 可用性门控 ----------
 * refs: instKey -> Set<entityId>，实例读/订阅/写过的实体即视为其依赖。
 * 实体被删 → 暂停引用它的实例；HA 断线 → 挂起全部实例，重连就绪后统一恢复。 */
const refs = new Map();          // instKey -> Set<eid>
const entityPaused = new Map();  // instKey -> Set<eid>，非空=因这些实体缺失而暂停
const HA_STATE = { READY: 'ready', OFFLINE: 'offline' };
/* 默认 READY：真实服务里 connector 就绪会调 onReady，断线调 onHaOffline；
 * 单测直接 start() 不走 connector 生命周期时默认放行（mock 视为就绪）。 */
let haState = HA_STATE.READY;

function trackRef(key, eid) {
  if (!eid || !key) return;
  let set = refs.get(key);
  if (!set) { set = new Set(); refs.set(key, set); }
  set.add(String(eid));
}

/* 运行时拓扑观测：在真实拦截点记录"发生过"的读写，脚本侧零声明。
 * mode/version 取自实例 entry；影子下 callService 被脚本层拦截，天然观测不到写实体。 */
function observeEntry(entry, kind, a, b, c) {
  if (!entry || entry.verifyMode === 'simulate') return; // 仿真跳过拓扑，不污染线上依赖图（§5）
  const sid = entry.sid;
  const mode = entry.dryRun ? 'shadow' : 'production';
  const version = entry.version;
  try {
    if (kind === 'read') topology.observeRead(sid, mode, version, a);
    else if (kind === 'service') topology.observeService(sid, mode, version, a, b, c);
    else if (kind === 'contextRead') topology.observeContextRead(sid, mode, version, a, b);
    else if (kind === 'context') topology.observeContext(sid, mode, version, a, b);
    else if (kind === 'call') topology.observeCall(sid, mode, version, a);
    else if (kind === 'taskDep') topology.observeTaskDep(sid, mode, version, a);
  } catch (e) { /* 观测失败不影响脚本 */ }
}
function clearRefs(key) { refs.delete(key); entityPaused.delete(key); }
function getRefs(key) { return [...(refs.get(key) || [])]; }

/* HA 连接器是否就绪：优先用 connector.isReady()（真相源），
 * 没有该方法的 mock connector（单测用）视为就绪，避免独立 haState 标志与之漂移。 */
function connectorReady(connector) {
  if (!connector) return false;
  return typeof connector.isReady === 'function' ? connector.isReady() === true : true;
}

/* 是否允许某个实例执行写操作：HA 就绪 + 没有因实体缺失而暂停。
 * 断线/实体暂停时写操作在 executor 层统一跳过（reply ok+skipped，不让脚本崩溃）。 */
function writeAllowed(key, connector) {
  /* 显式断线信号（onHaOffline）或 connector 自报未就绪，任一成立都拦写。 */
  if (haState !== HA_STATE.READY || !connectorReady(connector)) return false;
  const pausedSet = entityPaused.get(String(key));
  return !pausedSet || pausedSet.size === 0;
}

/* 某实体被删：暂停所有引用它的运行实例（只暂停一次，记日志 + 广播 paused）。
 * 通过 refs 动态判定依赖，无需改脚本源码声明实体清单。 */
function pauseScriptsForMissingEntity(eid) {
  const key = String(eid || '');
  for (const [inst, entry] of running) {
    if (!getRefs(inst).includes(key)) continue;
    let set = entityPaused.get(inst);
    if (!set) { set = new Set(); entityPaused.set(inst, set); }
    if (set.has(key)) continue; // 已暂停
    const first = set.size === 0;
    set.add(key);
    if (!first) continue;
    emitLog(entry, 'warn', `[兜底] 依赖实体 ${key} 被删除，脚本已暂停（实体恢复后自动继续）`);
    try { entry.child.send({ type: 'suspend', reason: 'entity-missing', entityId: key }); } catch (e) {}
    broadcastScript(entry.sid, entry.version, 'status', { status: 'paused', reason: 'entity-missing' });
    notifyCtxWriterState(entry.sid, 'entity-missing', entry);
  }
}

/* 实体重新出现：从各实例的暂停原因中移除，全部原因清空则恢复运行。 */
function resumeScriptsForEntity(eid) {
  const key = String(eid || '');
  for (const [inst, set] of entityPaused) {
    if (!set.has(key)) continue;
    set.delete(key);
    if (set.size > 0) continue;
    entityPaused.delete(inst);
    const entry = running.get(inst);
    if (!entry) continue;
    emitLog(entry, 'info', `[兜底] 依赖实体 ${key} 已恢复，脚本自动继续`);
    try { entry.child.send({ type: 'resume' }); } catch (e) {}
    broadcastScript(entry.sid, entry.version, 'status', { status: 'running', reason: 'entity-restored' });
    notifyCtxWriterState(entry.sid, 'entity-restored', entry);
  }
}

/* HA 断线：全局挂起所有运行脚本（不改 meta 状态，UI 由 HA 徽标体现"重连中"）。
 * 恢复由 onHaReady 统一处理。 */
function onHaOffline() {
  if (haState === HA_STATE.OFFLINE) return;
  haState = HA_STATE.OFFLINE;
  for (const entry of running.values()) {
    emitLog(entry, 'warn', '[兜底] HA 连接断开，脚本写操作已挂起（重连后自动继续）');
    try { entry.child.send({ type: 'suspend', reason: 'ha-offline' }); } catch (e) {}
  }
}

/* HA 就绪（缓存回填完成）：解除全局挂起，脚本恢复动作。
 * 因实体缺失暂停的脚本不放行（它们的实体可能真的没了）。
 * 断线窗口内的实体增删没有 state_changed 事件、重连快照也不走 onStateChange：
 * 就绪后用 entityStatus 对全部依赖实体复核一遍，补齐暂停/恢复。 */
function onHaReady() {
  const wasOffline = haState === HA_STATE.OFFLINE;
  haState = HA_STATE.READY;
  if (currentConnector && typeof currentConnector.entityStatus === 'function') {
    for (const [inst] of running) {
      for (const eid of getRefs(inst)) {
        const st = currentConnector.entityStatus(eid);
        if (st === 'missing') pauseScriptsForMissingEntity(eid);
        else if (st === 'present') resumeScriptsForEntity(eid);
      }
    }
  }
  if (!wasOffline) return;
  for (const entry of running.values()) {
    if (entityPaused.get(entry.key) && entityPaused.get(entry.key).size) continue; // 仍因实体缺失暂停
    emitLog(entry, 'info', '[兜底] HA 连接已恢复，脚本继续运行');
    try { entry.child.send({ type: 'resume' }); } catch (e) {}
  }
}

/* S2：fork 子进程时剔除敏感环境变量，避免脚本逃逸后从 process.env 读到 token。 */
function childEnv() {
  const env = { ...process.env, HA3D_RUNNER: '1' };
  delete env.HA_TOKEN;
  delete env.HA_URL;
  return env;
}

function lockKey(domain, service, eid) { return `${domain}.${service}.${eid || '*'}`; }

/* 受控调用：同键互斥（inflight）+ 冷却；冲突返回 {ok:false, reason} 而非静默覆盖。
 * L5：inflight 标记在请求完成后由 releaseAction 清除，保证"互斥"而非仅冷却。 */
function acquireAction(domain, service, eid) {
  const cfg = getConfig();
  const key = lockKey(domain, service, eid);
  const now = Date.now();
  const prev = actionLocks.get(key);
  if (prev && prev.inflight) return { ok: false, reason: '同一动作正在执行中（互斥）' };
  if (prev && now - prev.at < cfg.actionCooldownMs) {
    return { ok: false, reason: `冷却中（${cfg.actionCooldownMs}ms）` };
  }
  actionLocks.set(key, { at: now, inflight: true });
  pruneActionLocks(now, cfg.actionCooldownMs);
  return { ok: true, key };
}
function releaseAction(key) {
  const cur = actionLocks.get(key);
  if (cur) cur.inflight = false;
}

/* 惰性清理：动作键按 domain.service.entityId 组合无限增长（长期运行慢性泄漏）。
 * 每次加锁时顺手清掉"早已结束且冷却期已过"的陈旧条目。 */
function pruneActionLocks(now, cooldownMs) {
  if (actionLocks.size < 256) return;
  for (const [k, v] of actionLocks) {
    if (!v.inflight && now - v.at >= cooldownMs) actionLocks.delete(k);
  }
}

function isRunning(id) { return instancesOf(id).length > 0; }

/* ---------- 运行状态（内存真相，2026-11-26 起 meta.json 不再存 status） ----------
 * running/paused 直接由运行时判定（running map + entityPaused）；
 * error 是"最后一次实例异常退出"标记，存内存 lastErrors，重启即清
 * （与旧 healStaleStatuses 把持久化 running/paused 归位 stopped 的语义一致）。
 * 重启恢复意图清单在 data/runtime/desired-running.json（run-state）。 */
const lastErrors = new Map(); // instKey(sid#v) -> { ts, reason }
function noteError(sid, version, reason) {
  lastErrors.set(instKey(sid, version), { ts: Date.now(), reason: String(reason || '') });
}
function clearError(sid, version) { lastErrors.delete(instKey(sid, version)); }
/* 版本级运行状态：running / paused / error / stopped */
function versionRuntimeStatus(sid, version) {
  const key = instKey(sid, Number(version));
  if (running.has(key)) return (entityPaused.get(key) && entityPaused.get(key).size) ? 'paused' : 'running';
  if (lastErrors.has(key)) return 'error';
  return 'stopped';
}
/* 脚本级运行状态（列表徽章口径）：任一实例在跑 → running（被暂停的实例除外）；
 * 全部实例都暂停 → paused；无实例但最近异常退出 → error；否则 stopped */
function scriptRuntimeStatus(sid) {
  const list = instancesOf(sid);
  if (list.length) {
    return list.some((e) => !(entityPaused.get(e.key) && entityPaused.get(e.key).size)) ? 'running' : 'paused';
  }
  for (const key of lastErrors.keys()) {
    if (parseKey(key).sid === String(sid)) return 'error';
  }
  return 'stopped';
}

/* 兼容接口：返回"主实例"版本——有正式实例优先正式，否则影子 */
function runningVersion(id) {
  const list = instancesOf(id);
  const prod = list.find((e) => !e.dryRun);
  const pick = prod || list[0];
  return pick ? pick.version : null;
}
/* 全部运行实例（正式 + 影子可并存），供列表/TUI 分辨 */
function runningVersions(id) {
  return instancesOf(id)
    .map((e) => ({ version: e.version, mode: e.dryRun ? 'shadow' : 'production', verifyMode: e.verifyMode || 'follow', startedAt: e.startedAt, host: e.host || 'fork' }))
    .sort((a, b) => a.version - b.version);
}
function runningList() {
  return [...running.values()].map((r) => ({
    id: r.sid, version: r.version, mode: r.dryRun ? 'shadow' : 'production', verifyMode: r.verifyMode || 'follow',
    startedAt: r.startedAt, restarts: r.restarts,
    pid: r.child && r.child.pid ? r.child.pid : null, // 运维/诊断用：可定位失控子进程
  }));
}

/* 详情接口用的状态聚合（REST /api/script/:id 与 MCP get_script_status 共用，此前两处各自
 * 并行调 5 个函数拼同一组字段，改口径要同步两处）。status=版本级（当前版本徽章）；
 * scriptStatus=脚本级（列表徽章口径）——两者口径不同，前端回填列表必须用 scriptStatus。 */
function statusSummary(sid, version) {
  return {
    status: versionRuntimeStatus(sid, version),
    scriptStatus: scriptRuntimeStatus(sid),
    running: isRunning(sid),
    runningVersion: runningVersion(sid),
    runningVersions: runningVersions(sid),
  };
}

/* ---------- ctx.task（status / require / watch）：依赖脚本状态裁决 ----------
 * 只读接口一律看依赖的**正式实例**，与调用者影子/正式无关：状态查询、等待、监听
 * 都不产生设备副作用，没必要做通道隔离。写隔离仍由 ctx.write / ctx.global.set 负责。
 * 返回值保留 version/mode 供日志辨识（mode 正常恒为 production）。重启抖动业务侧防抖。 */
function pickTaskInstance(sid) {
  return instancesOf(sid).find((e) => !e.dryRun) || null;
}
function pausedByEntity(entry) {
  const set = entityPaused.get(entry.key);
  return !!(set && set.size);
}
function taskStateFor(sid, reason) {
  const pick = pickTaskInstance(sid);
  if (!pick) {
    /* 没有实例：查正式通道最新版本；error 判定走内存（最后一次异常退出标记） */
    const version = store.versionOfChannel(sid, 'production');
    let state = 'stopped';
    if (version != null && versionRuntimeStatus(sid, version) === 'error') state = 'error';
    const info = { scriptId: sid, version, mode: 'production', reason: reason || 'no-instance' };
    return { scriptId: sid, version, mode: 'production', state, info };
  }
  const state = pausedByEntity(pick) ? 'paused' : 'running';
  const info = { scriptId: sid, version: pick.version, mode: 'production', reason: reason || '' };
  return { scriptId: sid, version: pick.version, mode: 'production', state, info };
}
/* ctx.global.watch 的写者状态折叠：写者实例状态变化时，对它写过的每个 global key 的
 * 订阅者派发 contextWriterState（value = prev = 当前存量值，旧消费者当作"值没变的通知"
 * 消化，天然兼容）。防抖在 runner 侧做（虚拟时钟），宿主只如实转发状态事实。
 * changedEntry 为影子实例（dryRun）时直接忽略：只读流统一看正式实例，影子状态变化
 * 不通知任何人（与原 task.watch / writerState 同一口径）。 */
function notifyCtxWriterState(sid, reason, changedEntry) {
  if (changedEntry && changedEntry.dryRun) return;
  if (!store.safeId(sid)) return;
  const keysMap = ctxWatchers.get('production');
  if (!keysMap) return;
  const keys = context.keysByWriter('production', sid);
  if (!keys.length) return;
  const st = taskStateFor(sid, reason);
  for (const key of keys) {
    const subs = keysMap.get(key);
    if (!subs || !subs.size) continue;
    const value = context.get('global', sid, key, false, undefined);
    for (const entry of [...subs]) {
      if (entry.sid === sid) continue; // 写者不通知自己
      try {
        entry.child.send({
          type: 'contextWriterState', scope: 'global', key,
          value, prev: value, scriptId: sid, state: st.state,
          namespace: 'production', reason: reason || '',
        });
      } catch (e) {}
    }
  }
}

/* 终态收尾公共段（done / onExit 最终退出 / stop 取消挂起重启 三条路径共用）：
 * 异常标记归位 + 状态广播 + 任务观察者通知。差异只在各自前置的实例清理
 * （cleanup、clearRefs、runState.clear），保持就地；新增终态字段只改这一处。
 * error 传异常原因（记入 lastErrors 给 UI/AI 自诊断）；非 error 状态清除异常标记。 */
function settleStatus(sid, version, { status, error, reason, entry }) {
  if (status === 'error') noteError(sid, version, error);
  else clearError(sid, version);
  broadcastScript(sid, version, 'status', { status });
  notifyCtxWriterState(sid, reason, entry);
}

function broadcastScript(id, version, event, extra) {
  /* status 事件附带实例通道（shadow/production）：前端直接消费，不再用 shadowVersion
   * 反推——发布切换窗口内 shadowVersion 已变，反推会把新影子误标成 production。
   * 终态事件（实例已摘除）带不上 mode，前端停止路径用不到 mode，缺席即回退。 */
  const entry = event === 'status' ? running.get(instKey(id, version)) : null;
  hub.broadcast({ type: 'script', event, scriptId: id, version, ts: Date.now(),
    ...(entry ? {
      mode: entry.dryRun ? 'shadow' : 'production',
      /* 验证方式随状态事件下发：前端徽章据此区分「跟随真实」与「仿真」，
       * 不再靠 mode=shadow 一概而论（仿真也是影子身份，§3.1）。 */
      verifyMode: entry.verifyMode || 'follow',
    } : {}), ...(extra || {}) });
  /* 状态变化必须同步左侧列表：前端只对"当前打开的脚本"消费 status 事件，
   * 其余脚本若不重拉列表，徽标会残留旧状态（如已停仍显示运行中） */
  if (event === 'status') broadcastRefresh(['scripts']);
}

/* 执行方式：EXECUTION_MODE / config.json 的 executionMode，三选一（模块级：start 选宿主、
 * publish 宿主迁移两处共用）：
 *   fork（默认）  = 每脚本一个子进程，卡死由进程隔离兜底（隔离最硬）；
 *   inprocess     = 全部脚本在主进程内 vm 执行，最省内存（回调有 V8 timeout 防死循环）；
 *   worker        = 每脚本一个 worker 线程，OS 抢占式公平调度 + terminate 强杀，内存居中。
 * 三种模式的 child 句柄同形状（send/on/kill/stdout/exit），上层生命周期逻辑完全复用。
 *
 * 影子强制专属 worker（2026-11-26 热池改造）：影子是未验证代码（反复试错，死循环/崩溃/
 * 泄漏概率高），任何全局模式下都独享一个全新 worker 线程——失控只影响自己，看门狗可杀可
 * 重启；热池里只剩已验证的正式脚本。dryRun=false 时才按 EXECUTION_MODE 选宿主。 */
const EXECUTION_MODES = store.EXECUTION_HOST_MODES;
const executionMode = EXECUTION_MODES.includes(getConfig().executionMode) ? getConfig().executionMode : 'fork';

/* callInfo（ctx.call 内部用）：{ callDepth, callerSid, params }。
 * 只作为本次实例的运行属性，不写回 meta/仓库——调用关系是一次性的，不是脚本定义。 */
function start(id, version, connector, restarts = 0, callInfo = null, opts = {}) {
  const sid = String(id || '');
  if (!store.safeId(sid)) throw new Error('脚本 id 非法');
  /* verifyMode 是影子实例的运行时验证方式：follow（真实数据）/ simulate（虚拟世界）。
   * 只影响影子实例；正式实例一律 follow。仿真只覆盖本脚本，不联动其他脚本。 */
  const verifyMode = opts.verifyMode === 'simulate' ? 'simulate' : 'follow';
  const rec = store.get(sid, version);
  if (!rec) throw new Error('脚本版本不存在');
  if (!rec.script) throw new Error('脚本源码为空');
  const key = instKey(sid, rec.version);
  if (running.has(key)) throw new Error(`版本 v${rec.version} 已在运行`);
  /* 实例槽位：同一脚本最多 1 个正式 + 1 个影子。
   * 这样"正式在跑、影子同时验证"互不影响；两个正式会争抢设备，必须拒绝。
   * 开发模式不再改通道身份：正式实例保持 dryRun=false（写正式上下文桶、可自动恢复、
   * 可发布），只对设备写下发加一道 devMode 闸（见 callService / metaForRunner.devMode）。 */
  const dryRun = store.channelOf(rec.meta) !== 'production';
  const siblings = instancesOf(sid);
  if (dryRun) {
    const other = siblings.find((e) => e.dryRun);
    if (other) throw new Error(`影子实例 v${other.version} 正在运行，同一脚本同时只能有一个影子实例（先停止它）`);
  } else {
    const other = siblings.find((e) => !e.dryRun);
    if (other) throw new Error(`正式版本 v${other.version} 正在运行，同一脚本只能有一个正式实例（先停止它再启动 v${rec.version}）`);
  }
  if (connector) currentConnector = connector; // 每次启动同步一次连接器引用（重启也走这里）
  /* 重新运行 = 异常标记清除（旧状态机 error/draft/paused → stopped → running 的内存等价） */
  clearError(sid, rec.version);

  /* 宿主选择（2026-11-26 热池改造）：
   * 1. 影子：强制专属 worker（每次新建、用完即毁——独立宿主硬隔离；用户口径：不必 fork
   *    独立进程，全新 worker 即可，写隔离仍由主进程执行器硬拦截兜底）。优先级最高。
   * 2. 正式 + 一次性脚本（kind=script/scene）+ 未显式指定 meta.hostMode → 热池会话
   *    （常热 worker、触发≈一次 postMessage）；池满降级为每次新建 worker（退化即现状）。
   * 3. 显式 meta.hostMode（fork/inprocess/worker 三值对称）> 全局 EXECUTION_MODE 默认，
   *    常驻自动化不受热池影响。 */
  const explicitHost = EXECUTION_MODES.includes(rec.meta.hostMode) ? rec.meta.hostMode : null;
  const isOneShot = store.kindOf(rec.meta) !== 'automation';
  let hostMode;
  let child;
  if (dryRun) {
    hostMode = 'worker';
    child = createWorkerChild({ env: childEnv() });
  } else if (!explicitHost && isOneShot) {
    const sess = hotPool.acquireSession({ env: childEnv() });
    if (sess) {
      hostMode = 'hot';
      child = sess;
    } else {
      hostMode = 'worker'; // 池满：降级为一次性专属 worker（现状行为，不排队不阻塞）
      child = createWorkerChild({ env: childEnv() });
    }
  } else {
    hostMode = explicitHost || executionMode;
    child = hostMode === 'inprocess'
      ? createInlineChild()
      : hostMode === 'worker'
        ? createWorkerChild({ env: childEnv() })
        : fork(RUNNER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: childEnv() });
  }
  const entry = {
    child, key, version: rec.version, startedAt: Date.now(), restarts, sid, dryRun, host: hostMode,
    verifyMode: dryRun ? verifyMode : 'follow',
    callDepth: Math.max(0, Number(callInfo && callInfo.callDepth) || 0),
    callerSid: (callInfo && callInfo.callerSid) || null,
  };
  clearRefs(key); // 新实例重新收集引用实体与暂停状态
  running.set(key, entry);

  const cfg = getConfig();
  /* 常驻自动化（kind=automation）靠 onStateChange + 自身永久挂起运行，不适用一次性看门狗；
   * 仍可由 stop() 手动停、异常退出按 maxRestarts 重启。一次性脚本（script/scene）保留超时保护。 */
  let watchdog = null;
  /* kind 必须经 kindOf 派生：缺省按 automation 处理。直接读 rec.meta.kind 的话，
   * 缺 kind 的 meta 会把常驻自动化误判成一次性脚本（加看门狗后被杀）。
   * 典型路径：启动恢复 restore → store.get 时没有任何接口触发过 normalize（审计 P0-2）。 */
  if (store.kindOf(rec.meta) !== 'automation') {
    /* 脚本级超时覆盖（meta.runnerTimeoutMs）：一次性脚本可能含长延时（如吸氧 30 分钟），
     * 全局默认 60s 会误杀。与 hostMode 同策略：传了就用，未传跟随全局。 */
    const scriptTimeout = Number(rec.meta.runnerTimeoutMs);
    const timeoutMs = Number.isFinite(scriptTimeout) && scriptTimeout > 0
      ? scriptTimeout : cfg.runnerTimeoutMs;
    watchdog = setTimeout(() => {
      broadcastScript(sid, rec.version, 'status', { status: 'timeout' });
      stop(sid, 'timeout', rec.version);
    }, timeoutMs);
  }
  entry.watchdog = watchdog;

  /* 消息处理兜底：单个实例的消息异常只记日志，不上抛成主进程 uncaughtException
   * （inline 模式 EventEmitter 同步派发 listener，抛出会直接打进主进程）。 */
  child.on('message', (msg) => {
    try { handleChildMessage(entry, msg, connector); }
    catch (e) { emitLog(entry, 'error', '消息处理异常：' + (e && e.message || e)); }
  });
  child.stdout.on('data', (buf) => emitLog(entry, 'info', buf.toString().trim()));
  child.stderr.on('data', (buf) => emitLog(entry, 'error', buf.toString().trim()));
  child.on('error', (e) => { emitLog(entry, 'error', 'runner 进程错误：' + e.message); });
  child.on('exit', (code) => { entry.exited = true; onExit(entry, code); });

  /* M2 一致性校验已在入口按 channel 派生 dryRun（entry.dryRun），这里只复用它下发给 runner。
   * M10：把 runner 的 vm 超时派生值随 meta 下发，与看门狗保持统一差值（至少留 5s）。 */
  const effectiveTimeout = Number(rec.meta.runnerTimeoutMs) > 0 ? Number(rec.meta.runnerTimeoutMs) : cfg.runnerTimeoutMs;
  /* sid 用启动参数注入（权威值），不依赖 meta.id 是否被手工改过。 */
  const metaForRunner = { ...rec.meta, sid, dryRun: entry.dryRun, devMode: DEV_MODE, vmTimeoutMs: Math.max(1000, effectiveTimeout - 5000) };
  if (callInfo && callInfo.params !== undefined) metaForRunner.callParams = callInfo.params;
  /* simulate：把虚拟世界种子与起始时刻随 run 下发，worker 内建 VirtualClock/SimSession。
   * 不传 connector 给 runner（request 在 worker 内由 sim-host 应答，结构上没有真实 HA 引用）。 */
  if (entry.verifyMode === 'simulate') {
    metaForRunner.simulate = true;
    metaForRunner.simStartAt = opts.startAt;
    metaForRunner.simSeed = opts.seed;
    /* 仿真日志独立文件（§5）：会话开始时主进程清空，worker 与框架日志各自逐行追加。
     * 统一在这里清，worker 侧改为 'a' 追加——否则 worker 的覆盖写会抹掉先落的框架日志。 */
    store.clearSimLog(sid, rec.version);
    metaForRunner.simLogFile = store.simLogFile(sid, rec.version);
    /* 崩溃只读快照（§5.2）：新会话开始前清掉上一次的陈旧现场，避免误读。 */
    store.clearSimCrash(sid, rec.version);
    metaForRunner.simCrashFile = store.simCrashFile(sid, rec.version);
  }
  child.send({ type: 'run', script: rec.script, meta: metaForRunner });
  if (entry.callerSid) emitLog(entry, 'info', `[联动] 由脚本 ${entry.callerSid} 调用启动（第 ${entry.callDepth} 层）`);
  if (DEV_MODE && !dryRun) emitLog(entry, 'warn', '开发模式：正式实例已启动（身份/上下文均为正式），设备写操作只记日志不下发');
  /* 运行意图持久化：start 全部成功后才落盘，确保重启能按此版本恢复。 */
  /* 审计 4.11：simulate 实例不持久化运行意图——虚拟世界不持久化（§2.4），重启后按
   * follow 恢复会让"仿真"悄悄变成影子真跑；onExit 对 simulate 不自动重启也是同一意图。 */
  if (entry.verifyMode !== 'simulate') runState.mark(sid, rec.version, entry.startedAt);
  broadcastScript(sid, rec.version, 'status', { status: 'running' });
  notifyCtxWriterState(sid, 'started', entry);
  return entry;
}

function emitLog(entry, level, message, nodeId) {
  if (!message) return;
  const line = { ts: Date.now(), scriptId: entry.sid, version: entry.version, level, message, nodeId: nodeId || undefined };
  store.appendLog(entry.sid, entry.version, line);
  hub.broadcast({ type: 'script', event: 'log', ...line });
}

function handleChildMessage(entry, msg, connector) {
  if (msg.type === 'simReply') {
    simControl.resolveSimReply(msg); // 回执表归 sim-control 私有（审计 3.1），这里只转交
    return;
  }
  if (msg.type === 'log') {
    /* simulate 的日志不写版本日志（§9）；仍实时广播供前端看，带虚拟时刻 at 便于按 +Xs 对齐。 */
    if (entry.verifyMode !== 'simulate') emitLog(entry, msg.level, msg.message, msg.nodeId);
    else hub.broadcast({ type: 'script', event: 'log', ts: Date.now(), scriptId: entry.sid, version: entry.version, level: msg.level, message: msg.message, nodeId: msg.nodeId || undefined, at: msg.at, sim: true });
    return;
  }
  if (msg.type === 'simWrite') {
    /* 防御分支：worker 已在本地消费 simWrite（会话记写意图），正常不会到这里。
     * 万一别的宿主转发上来，也只能广播，绝不写版本日志（§9 不落盘）。
     * 带 at（缺省 0）：本分支 sim:true，前端按虚拟时刻渲染，与脚本日志 +X.Xs 口径一致（审计 4.12）。 */
    hub.broadcast({ type: 'script', event: 'log', ts: Date.now(), scriptId: entry.sid, version: entry.version,
      level: 'warn', message: `[仿真·写意图上报] ${msg.desc || msg.op || ''}（${msg.kind}）`, nodeId: msg.nodeId || undefined,
      at: typeof msg.at === 'number' ? msg.at : 0, sim: true });
    return;
  }
  if (msg.type === 'subscribe') {
    if (!msg.entityId) return; // 空 entityId 不建桶，避免 '' 桶泄漏与无效分发
    if (entry.verifyMode === 'simulate') return; // 仿真不进真实订阅表（§9）
    trackRef(entry.key, msg.entityId); // 订阅的实体也算依赖，被删时同样暂停
    observeEntry(entry, 'read', msg.entityId); // 运行时拓扑：订阅实体也是依赖
    let set = subscriptions.get(msg.entityId);
    if (!set) { set = new Set(); subscriptions.set(msg.entityId, set); }
    set.add(entry.child);
    return;
  }
  if (msg.type === 'contextSubscribe' || msg.type === 'contextUnsubscribe') {
    if (entry.verifyMode === 'simulate') return; // 仿真不进真实订阅表
    /* 只接 global；key 校验用 context.validKey（唯一实现），订阅桶固定 production（读不隔离，不信脚本） */
    if (msg.scope !== 'global') return;
    const key = context.validKey(msg.key);
    if (!key) return;
    if (msg.type === 'contextSubscribe') {
      addCtxWatcher(entry, key);
      observeEntry(entry, 'contextRead', 'global', key); // 运行时拓扑：订阅的上下文也算读取依赖
    } else removeCtxWatcher(entry, key);
    return;
  }
  if (msg.type === 'request') {
    handleRequest(entry, msg, connector)
      .catch((e) => emitLog(entry, 'error', '请求处理异常：' + (e && e.message || e)));
    return;
  }
  if (msg.type === 'done') {
    /* M7：身份判断——只处理"仍是当前实例"的 done，旧子进程迟到的 done 不得删新实例。 */
    if (running.get(entry.key) !== entry) return;
    emitLog(entry, msg.ok ? 'info' : 'error', msg.ok ? '完成' : ('失败：' + msg.error));
    clearTimeout(entry.watchdog);
    /* 先清持久化运行意图再摘内存实例：若在两步之间进程崩溃，重启后不会把一个
     * 已 done 的一次性脚本重新拉起（重复执行真实设备控制）。反过来先摘内存后清
     * 清单，崩溃窗口内残留的意图会被 restore 误恢复。 */
    runState.clear(entry.sid, entry.version); // 已自然结束，重启不再恢复
    cleanup(entry);
    /* M9：异常结束保持 error 标记（内存），不再紧跟一次 stopped 覆盖，保留失败信息给 UI/AI 自诊断。
     * 显式重跑（start）时由 clearError 归位。 */
    settleStatus(entry.sid, entry.version, {
      status: msg.ok ? 'stopped' : 'error',
      error: msg.error, reason: msg.ok ? 'done' : 'error', entry,
    });
  }
}

async function handleRequest(entry, msg, connector) {
  const { id, action, data } = msg;
  const reply = (ok, result, error) => { try { entry.child.send({ type: 'reply', id, ok, result, error }); } catch (e) {} };
  try {
    /* 上下文读写不依赖 HA 连接器。读侧：global 统一读 production（不隔离）；
     * local 是脚本私有桶，仍按调用者 dryRun 读。写侧：一律按调用者 dryRun 落桶隔离。 */
    if (action === 'contextGet') {
      const readScope = data.scope === 'global' ? 'global' : 'local';
      const readDryRun = readScope === 'global' ? false : entry.dryRun;
      observeEntry(entry, 'contextRead', readScope, data.key); // 运行时拓扑：真实读取的上下文
      const value = context.get(readScope, entry.sid, data.key, readDryRun, data.default);
      /* withMeta：global.watch 注册时拉取写者身份与写者当前状态（写者健康 = 正式实例，
       * 与 taskStateFor 同一裁决口径），供 runner 建 key→写者缓存与启动基线 */
      if (data.withMeta && readScope === 'global') {
        const w = context.writerOf(data.key, false);
        const ws = w ? taskStateFor(w).state : null;
        return reply(true, { v: value, w, ws });
      }
      return reply(true, value);
    }
    if (action === 'contextSet') {
      await context.set(data.scope, entry.sid, data.key, data.value, entry.dryRun);
      observeEntry(entry, 'context', data.scope, data.key); // 运行时拓扑：真实写入的上下文
      emitLog(entry, 'info', `[上下文] ${data.scope}.${data.key} 已写入${entry.dryRun ? '（影子命名空间）' : ''}`);
      return reply(true, { ok: true, scope: data.scope, key: data.key });
    }
    if (action === 'taskStatus') {
      const targetSid = String(data.scriptId || '');
      if (!store.safeId(targetSid)) return reply(false, null, '被查询脚本 id 非法');
      observeEntry(entry, 'taskDep', targetSid); // 运行时拓扑：查询依赖（ctx.task.status / require 底层共用）
      return reply(true, taskStateFor(targetSid, 'queried'));
    }
    if (action === 'callScript') {
      /* 脚本间显式联动：底层直接 start（不绕 HTTP），版本/命名空间跟随调用者。
       * 影子调用者不真实拉起被调脚本（影子硬隔离的同类延伸）：只做与正式路径一致的
       * 校验（目标存在影子版 / 非常驻 / id 合法 / params 可序列化），然后打日志并回
       * mock 回执（mocked:true）——防止影子验证期间 ctx.call 绕过隔离真实操控设备。
       * 影子 mock 不检查 busy/restartable（没有真实实例被拉起，不存在占用）。
       * 正式调用者照旧真实调用。 */
      const targetSid = String(data.scriptId || '');
      if (!store.safeId(targetSid)) return reply(false, null, '被调脚本 id 非法');
      const depth = Math.max(0, Number(entry.callDepth) || 0);
      if (depth >= MAX_CALL_DEPTH) return reply(false, null, `调用链深度超过 ${MAX_CALL_DEPTH} 层，已中断防递归`);
      const shadow = entry.dryRun;
      let params;
      try { params = data.params === undefined ? undefined : JSON.parse(JSON.stringify(data.params)); }
      catch (e) { return reply(false, null, 'ctx.call 的 params 必须可 JSON 序列化'); }
      if (shadow) {
        const version = store.versionOfChannel(targetSid, 'shadow'); // 只读解析，无副作用
        if (version == null) return reply(false, null, CALL_TEXT.noVersion(targetSid, 'shadow'));
        const rec = store.get(targetSid, version);
        if (!rec || !rec.script) return reply(false, null, CALL_TEXT.noScript);
        if (store.kindOf(rec.meta) === 'automation') return reply(false, null, CALL_TEXT.automation);
        emitLog(entry, 'warn', `[联动][影子] 调用 ${targetSid} v${version} 已 mock：影子模式不真实拉起被调脚本`);
        return reply(true, { id: targetSid, version, mode: 'shadow', started: true, mocked: true });
      }
      try {
        const { version } = startOneShot(targetSid, 'production', CALL_TEXT);
        const target = start(targetSid, version, currentConnector, 0, {
          callDepth: depth + 1, callerSid: entry.sid, params,
        });
        emitLog(entry, 'info', `[联动] 调用 ${targetSid} v${version}（正式）成功`);
        observeEntry(entry, 'call', targetSid); // 运行时拓扑：脚本间调用边（只在真实调起时记录）
        return reply(true, { id: targetSid, version, mode: 'production', started: true });
      } catch (e) {
        emitLog(entry, 'warn', `[联动] 调用 ${targetSid} 失败：${e && e.message || e}`);
        return reply(false, null, e && e.message || String(e));
      }
    }
    if (!connector) throw new Error('HA 连接器未就绪');
    if (action === 'getState') {
      trackRef(entry.key, data.entityId);
      observeEntry(entry, 'read', data.entityId); // 运行时拓扑：真实读取的实体
      /* HA 断线时 connector.getState 返回 null（不返回陈旧缓存）；脚本据此走保守分支，
       * 且写操作在下方被门控跳过，不会下发错误控制。 */
      return reply(true, connector.getState(data.entityId));
    }
    if (action === 'listEntities') return reply(true, connector.listEntities(data.filter));
    if (action === 'callService') {
      const { domain, service, data: sd } = data;
      const eid = sd && sd.entity_id;
      /* 宽限期内脚本续体/裸 callService 仍可能发写请求：entry 已在 stopInstance 标记 stopped，
       * 这里作为执行器侧硬闸拦截真实下发（与 runner 侧 ctx.write 闸双保险）。 */
      if (entry.stopped) {
        emitLog(entry, 'warn', `[兜底] 写操作跳过（实例已停止）：${domain}.${service}${eid ? ' ' + eid : ''}`);
        return reply(true, { skipped: true, reason: '实例已停止', domain, service, entityId: eid || null });
      }
      trackRef(entry.key, eid);
      /* 观测放在拦截之前：影子/开发模式的 callService 虽被拦不下发，但"打算写哪个实体"
       * 仍是有效拓扑信息（真实发生了一次写意图），记下来才能给影子脚本展示完整拓扑。 */
      observeEntry(entry, 'service', domain, service, eid);
      /* 影子模式 / 全局开发模式：所有 HA 服务调用（写操作）在主进程统一拦截，
       * 只记日志、绝不下发。读操作（getState/listEntities）不受影响。
       * 这是执行器层的硬隔离，即使脚本绕过自身写闸也无法碰到真实 HA。
       * 开发模式拦的是所有脚本实例（含正式通道），与 context 读写、发布无关。
       * MCP 直调不走这条路径（不拦），只拦脚本发起的写。 */
      if (entry.dryRun) {
        emitLog(entry, 'warn', shadowHa(domain, service, eid));
        return reply(true, { shadow: true, skipped: true, domain, service, entityId: eid || null });
      }
      if (DEV_MODE) {
        emitLog(entry, 'warn', devHa(domain, service, eid));
        return reply(true, { devMode: true, skipped: true, domain, service, entityId: eid || null });
      }
      /* 兜底门控：HA 断线或脚本因实体缺失暂停时，写操作跳过并记日志，
       * reply(ok=true, skipped) —— 不让脚本收到 reject 而崩溃/重启风暴。 */
      if (!writeAllowed(entry.key, connector)) {
        const reason = !connectorReady(connector) ? 'HA 断线' : '依赖实体缺失已暂停';
        emitLog(entry, 'warn', `[兜底] 写操作跳过（${reason}）：${domain}.${service}${eid ? ' ' + eid : ''}`);
        return reply(true, { skipped: true, reason, domain, service, entityId: eid || null });
      }
      const chk = acquireAction(domain, service, eid);
      if (!chk.ok) {
        /* 互斥/冷却冲突不再 reply(false) 让脚本崩溃，改为跳过+日志（避免重启风暴）。 */
        emitLog(entry, 'warn', `[兜底] 写操作跳过（${chk.reason}）：${domain}.${service}${eid ? ' ' + eid : ''}`);
        return reply(true, { skipped: true, reason: chk.reason, domain, service, entityId: eid || null });
      }
      try {
        const result = await connector.callService(domain, service, sd);
        return reply(true, result);
      } catch (e) {
        /* HA 下发失败（断线/超时）：记日志并跳过，不抛给脚本。 */
        emitLog(entry, 'warn', `[兜底] HA 下发失败已跳过：${domain}.${service}${eid ? ' ' + eid : ''}（${e && e.message || e}）`);
        return reply(true, { skipped: true, reason: 'HA 下发失败', error: e && e.message || String(e) });
      } finally {
        releaseAction(chk.key); // L5：请求结束（成功/失败）后释放互斥锁
      }
    }
    return reply(false, null, '未知 action：' + action);
  } catch (e) {
    return reply(false, null, e && e.message || String(e));
  }
}

function onStateChange(eid, next, prev) {
  const key = String(eid || '');
  /* 兜底：实体被删（next=null，之前存在）→ 暂停所有引用它的脚本；
   * 实体重新出现（prev=null/缺失，next 非空）→ 自动恢复。 */
  if (next == null && prev != null) pauseScriptsForMissingEntity(key);
  else if (next != null && prev == null) resumeScriptsForEntity(key);

  const set = subscriptions.get(key);
  if (!set || !set.size) return;
  for (const child of set) {
    try { child.send({ type: 'state', entityId: eid, state: next, prev }); } catch (e) {}
  }
}

/* 子进程从订阅表摘除（三处共用：cleanup / stopInstance / onExit，改口径只动这一处） */
function detachChild(entry) {
  for (const [eid, set] of subscriptions) {
    set.delete(entry.child);
    if (!set.size) subscriptions.delete(eid);
  }
  for (const [, keys] of ctxWatchers) {
    for (const [key, set] of keys) {
      if (set.delete(entry) && !set.size) keys.delete(key);
    }
  }
}

function cleanup(entry) {
  clearTimeout(entry.watchdog);
  running.delete(entry.key);
  clearRefs(entry.key);
  detachChild(entry);
  try { entry.child.kill(); } catch (e) {}
}

/* L2：优雅停止——先发 stop IPC 让长驻脚本检查 ctx.stopped 让步退出，
 * 宽限期后未自行退出再 SIGTERM 兜底，避免中断正在进行的 HA 调用。
 * 支持"只停某个版本"：stop(id, reason, version)；不给 version 则停该脚本全部实例
 * （正式 + 影子都停），这是 UI 上"全部停止"的语义。 */
const STOP_GRACE_MS = 500;
/* 自动重启倒计时登记（instKey → timer）：实例崩溃后进入 500ms 重启窗口时已从 running
 * 表摘除，stop() 按实例查不到目标会返回 false，而窗口结束后脚本照常拉起——用户明确
 * 停止的脚本会"复活"（审计 2026-11-26 P0-3）。stop/stopAll 通过这张表取消挂起重启。 */
const pendingRestarts = new Map();
function stopInstance(entry, reason) {
  emitLog(entry, 'info', '停止脚本：' + (reason || '手动') + (entry.dryRun ? '（影子实例）' : '（正式实例）'));
  /* 先清运行意图再摘内存实例：崩溃窗口内不会残留"已停止但仍要恢复"的意图。
   * 主动停止/超时 → 清除运行意图，重启不再恢复；
   * 服务关闭（shutdown）→ 保留意图，下次启动按清单恢复。宽限期内若被重启，start() 会重新 mark。 */
  if (reason !== 'shutdown') runState.clear(entry.sid, entry.version);
  entry.stopped = true; // 宽限期内仍可能收到在途 request：callService 据此拦下发（runner 侧 stopped 是子进程私有标志，此处独立）
  running.delete(entry.key); // 先摘除，避免宽限期内重复 stop / done 误处理
  clearRefs(entry.key);
  clearTimeout(entry.watchdog);
  detachChild(entry);
  notifyCtxWriterState(entry.sid, reason === 'timeout' ? 'timeout' : 'stopped', entry);
  try { entry.child.send({ type: 'stop' }); } catch (e) {}
  setTimeout(() => {
    try { entry.child.kill(); } catch (e) {}
    /* 宽限期内同一实例键可能已被重新登记（发布切换 / 崩溃重启）：
     * 键已含版本号，cur 存在即说明该键已归新实例所有，不覆盖它的状态；
     * cur 不存在说明该版本确实不在了，状态归位。 */
    const cur = running.get(entry.key);
    if (cur) return;
    /* 超时 → error 标记（内存）；主动停止/其他退出 → stopped 并清除异常标记 */
    if (reason === 'timeout') noteError(entry.sid, entry.version, 'timeout');
    else clearError(entry.sid, entry.version);
    broadcastScript(entry.sid, entry.version, 'status', { status: reason === 'timeout' ? 'error' : 'stopped' });
  }, STOP_GRACE_MS);
}

function stop(id, reason, version) {
  const sid = String(id || '');
  let stopped = false;
  const targets = version == null
    ? instancesOf(sid)
    : [running.get(instKey(sid, version))].filter(Boolean);
  for (const entry of targets) { stopInstance(entry, reason); stopped = true; }
  /* 崩溃实例正处于自动重启倒计时：取消重启并走终态清理（停止意图优先于自动重启） */
  for (const [key, p] of [...pendingRestarts]) {
    const parsed = parseKey(key);
    if (parsed.sid !== sid) continue;
    if (version != null && parsed.version !== version) continue;
    pendingRestarts.delete(key);
    clearTimeout(p.timer);
    emitLog(p.entry, 'info', '实例崩溃后处于自动重启倒计时，已按停止请求取消重启');
    clearRefs(key);
    runState.clear(sid, parsed.version);
    settleStatus(sid, parsed.version, { status: 'stopped', reason: 'stopped', entry: p.entry });
    stopped = true;
  }
  return stopped;
}

/* 提交脚本（含"修改当前影子"语义）。影子是可反复修改的工作副本，若被改的正是
 * 正在运行的影子，先停掉它——否则新代码不会生效，还会以为改的版本在跑。
 * newVersion:true 提交会把**当前影子归档**：它在跑的话同样先停（归档版本不应继续运行，
 * 且不释放槽位会让新影子启动报"同时只能有一个影子实例"）。 */
function stopRunningShadow(sid, reason) {
  const curShadow = store.versionOfChannel(sid, 'shadow');
  if (curShadow != null && running.has(instKey(sid, curShadow))) {
    const entry = running.get(instKey(sid, curShadow));
    emitLog(entry, 'warn', `影子版本 v${curShadow} 正在运行，${reason}前已停止（需重新 start 才生效）`);
    stop(sid, reason, curShadow);
    return true;
  }
  return false;
}

function submitScript(id, opts = {}) {
  const sid = String(id || '');
  if (!store.safeId(sid)) return store.submit(id, opts);
  if (opts.newVersion) {
    stopRunningShadow(sid, '新版本提交（旧影子将被归档）');
  } else if (!opts.channel || opts.channel === 'shadow') {
    stopRunningShadow(sid, '修改内容');
  }
  /* channel=production 直建正式版：不动影子实例（当前影子保持原样，由 store 决定版本号） */
  return store.submit(id, opts);
}

/* 回滚 = 读历史版本源码提交为新影子。若被回滚的旧影子仍在跑（会被归档），先停——
 * 与 submitScript 的停止逻辑对齐，避免"归档版本继续运行 + 占住影子槽位"。 */
function rollback(id, fromVersion) {
  const sid = String(id || '');
  if (store.safeId(sid)) stopRunningShadow(sid, '回滚提交');
  return store.rollback(id, fromVersion);
}

/* 发布影子版本为正式版本。旧正式自动归档（store.publish 内完成）。
 * 目标：发布后**只剩一个正式实例**在真实下发。三种情形：
 *   A. 目标影子版本自身正在运行 → 停掉旧正式实例（如有）→ 目标实例热切为正式；
 *   B. 目标未运行、但有旧正式实例在跑 → 停旧 → 以影子身份启动目标（dryRun=true 安全）
 *      → publish → 热切为正式；启动失败回退旧版本；
 *   C. 都没在跑 → 仅改仓库通道。
 * opts.autoSwitch=false 时退化为严格模式：情形 A/B 直接报错要求先手动停止。 */
/* 发布失败回退公共段（两处共用）：尽力拉起旧正式版本；回退也失败则留痕——
 * 此时没有任何实例在跑，设备控制已中断，必须广播 error 让用户手动启动。 */
function fallbackToOldVersion(sid, oldVersion) {
  try {
    start(sid, oldVersion, currentConnector, 0);
  } catch (e2) {
    emitLog({ sid, version: oldVersion }, 'error', `发布失败后回退 v${oldVersion} 也失败：${e2.message}（请手动启动该版本）`);
    broadcastScript(sid, oldVersion, 'status', { status: 'error' });
  }
}

function publish(id, version, opts = {}) {
  /* 开发模式允许发布：通道切为正式、实例可恢复，但设备写仍被 devMode 闸拦住，
   * 验证的是发布流程与上下文流转，不接管真实设备。 */
  const sid = String(id || '');
  /* publish 守卫：存在 simulate 实例时拒绝发布，提示先切回 follow 完成实跑验证（§9）。
   * 仿真通过不是上线依据。 */
  if (instancesOf(sid).some((e) => e.verifyMode === 'simulate')) {
    throw new Error('该脚本有仿真（simulate）实例在运行，请先切回 follow 完成实跑验证后再发布');
  }
  const targetV = version == null ? store.versionOfChannel(sid, 'shadow') : Number(version);
  if (targetV == null) throw new Error('没有可发布的影子版本');
  const prodEntry = instancesOf(sid).find((e) => !e.dryRun);
  const targetEntry = running.get(instKey(sid, targetV));
  const switching = !!prodEntry && prodEntry.version !== targetV;
  const oldVersion = prodEntry ? prodEntry.version : null;

  if (switching) {
    if (opts.autoSwitch === false) {
      throw new Error(`正式版本 v${oldVersion} 正在运行，与要发布的 v${targetV} 不一致：请先停止再发布`);
    }
    emitLog(prodEntry, 'warn', `发布 v${targetV}：先停止运行中的正式实例 v${oldVersion}`);
    stopInstance(prodEntry, 'publish-switch');
    /* 立刻归位旧版本状态：stop 的宽限期归位是异步的，这期间接口不该报告"归档版本还在运行" */
    clearError(sid, oldVersion);
  }
  if (!targetEntry && switching) {
    try {
      start(sid, targetV, currentConnector, 0); // 以影子身份启动，先不真实下发
    } catch (e) {
      fallbackToOldVersion(sid, oldVersion);
      throw new Error(`新版本 v${targetV} 启动失败，已回退到 v${oldVersion}：${e.message}`);
    }
  }

  let result;
  try {
    result = store.publish(sid, targetV);
    /* 发布即清观测（纯内存）：旧版本拓扑立即失效，全局图不再展示已下线版本的数据；
     * 新正式版本跑起来后拓扑从头观测。 */
    topology.clear(sid);
  } catch (e) {
    if (switching) {
      try { stop(sid, 'publish-failed', targetV); } catch (e2) {}
      fallbackToOldVersion(sid, oldVersion);
    }
    throw e;
  }

  const live = running.get(instKey(sid, result.version));
  if (live && live.dryRun) {
    /* 目标宿主 = 该正式版本的有效宿主（脚本级 meta.hostMode 覆盖 > 全局 EXECUTION_MODE）。
     * 影子已统一为专属 worker（2026-11-26 热池改造），热切换条件泛化为「目标宿主 === 影子宿主」：
     * 目标也是 worker（meta 覆盖为 worker 或全局 EXECUTION_MODE=worker）时同宿主零中断热切换。 */
    const pubRec = store.get(sid, result.version);
    const target = pubRec && EXECUTION_MODES.includes(pubRec.meta.hostMode) ? pubRec.meta.hostMode : executionMode;
    if (target === live.host) {
      /* 同宿主热切换：宿主形态不变，热切换 dryRun 零中断即可 */
      live.dryRun = false;
      emitLog(live, 'warn', `版本 v${result.version} 已发布为正式版本，切换为正式通道（${target} 宿主不变）${DEV_MODE ? '；开发模式下设备写仍只记日志' : '，真实下发'}`);
      try { live.child.send({ type: 'mode', dryRun: false }); } catch (e) {}
    } else {
      /* 跨宿主迁移：影子 worker 线程 → 目标宿主（fork 子进程 / inprocess 主进程）。
       * VM 状态无法跨进程/线程序列化，热切换宿主不可能，只能 stop+start：
       * stop 同步释放 running key，影子 worker 经宽限期让步退出后被 terminate（无残留）；
       * start 时 dryRun=false → hostMode=目标宿主 重建正式实例。 */
      emitLog(live, 'warn', `版本 v${result.version} 已发布为正式版本：释放影子 ${live.host} 宿主，按 ${target} 模式重建正式实例`);
      stopInstance(live, 'publish-switch-host');
      clearError(sid, result.version);
      try {
        start(sid, result.version, currentConnector, 0);
      } catch (e) {
        /* 迁移失败：仓库通道已是正式，只差实例没跑起来——留痕并广播错误态，可手动 start */
        emitLog({ sid, version: result.version }, 'error', `正式实例按 ${target} 模式启动失败：${e.message}（请手动启动）`);
        broadcastScript(sid, result.version, 'status', { status: 'error' });
      }
    }
  }
  /* 'published' 事件前端不消费；列表/版本条/详情刷新由下面三条 refresh 广播承担。
   * 必须带 script：publish 把 meta.channel 从 shadow 改为 production，而前端"进入仿真"
   * 等按钮只看详情里的 meta.channel。MCP 发布不走前端 store.publish 的 open()，若这里
   * 不广播 script，详情会卡在旧 shadow，按钮残留到用户手动切换脚本才消失。 */
  broadcastRefresh(['scripts', 'script', 'versions'], { scriptId: sid, version: result.version });
  return { ...result, switchedFrom: switching ? oldVersion : null };
}

/* 刷新广播统一出口：what 维护在 ['scripts','script','versions','logs']（前端 ws-client 消费的集合）。
 * 提交/发布/回滚等动作统一走这里，新增维度改一处即可。
 * extra 可带 { scriptId, version }：前端收到 what:'script' 时会切到该版本重拉详情，
 * 用于"提交影子后详情仍停在旧正式版"的场景；不带时保持原行为（重拉当前打开的版本）。 */
function broadcastRefresh(items, extra) {
  const payload = extra && typeof extra === 'object' ? extra : {};
  for (const what of items) hub.broadcast({ type: 'refresh', what, ...payload, ts: Date.now() });
}

/* 清理版本：正在运行的版本不可删，其余交给仓库删除目录+日志 */
function removeVersion(id, version) {
  const sid = String(id || '');
  if (running.has(instKey(sid, version))) throw new Error('不能删除正在运行的版本 v' + version + '，请先停止');
  const result = store.removeVersion(sid, version);
  /* 异常标记同步清理：lastErrors 按 sid#v 键控，版本删了标记还留着会让
   * scriptRuntimeStatus 永远报"异常"，且 Map 只增不减（审计 P1-#5） */
  lastErrors.delete(instKey(sid, version));
  broadcastRefresh(['scripts']);
  return result;
}

/* 删除整个脚本（全部版本）：任何实例（正式/影子）在运行即拒绝；
 * 运行意图清单兜底清理（正常停止后已清，防残留导致重启时恢复失败）。 */
function removeScript(id) {
  const sid = String(id || '');
  const rvs = instancesOf(sid);
  if (rvs.length) {
    throw new Error('脚本有实例在运行（' + rvs.map((e) => 'v' + e.version).join('、') + '），请先停止再删除');
  }
  for (const [, info] of Object.entries(runState.read())) {
    if (info && info.scriptId === sid) runState.clear(sid, info.version);
  }
  /* 异常标记全部清理（按 instKey 前缀 sid# 匹配），否则脚本删除重建后仍显示"异常" */
  for (const key of [...lastErrors.keys()]) {
    if (parseKey(key).sid === sid) lastErrors.delete(key);
  }
  const result = store.removeScript(sid);
  /* 脚本删除后观测数据立即失效，避免全局图残留已删除脚本的子图 */
  topology.clear(sid);
  broadcastRefresh(['scripts']);
  return result;
}

function stopAll() {
  for (const entry of [...running.values()]) stopInstance(entry, 'shutdown');
  /* 取消挂起的自动重启：shutdown 期间定时器到期会在退出阶段再 spawn 子进程。
   * 保留运行意图（runState 不清），下次启动按清单恢复。 */
  for (const [, p] of pendingRestarts) clearTimeout(p.timer);
  pendingRestarts.clear();
  hotPool.shutdown(); // 热池 worker 一并终止（会话随 exit(1) 走崩溃路径，此时 running 已清空）
}

/* 进程重启后按持久化运行意图恢复：start() 会重新 mark（刷新 startedAt），
 * 并对每个恢复的实例记录一条日志。清单条目若版本已不存在/源码损坏则跳过并清理，
 * 避免残留脏数据反复导致恢复失败。connector 应已就绪（调用方保证），确保脚本
 * 启动读取 HA 实体状态时缓存已填充。 */
function restore(connector) {
  const desired = runState.read();
  const result = { restored: [], skipped: [] };
  for (const [key, info] of Object.entries(desired)) {
    const parsed = parseKey(key);
    const sid = info.scriptId || parsed.sid;
    const version = info.version;
    if (!store.safeId(sid) || !Number.isInteger(version) || version < 1) {
      result.skipped.push({ id: sid, version, reason: '清单条目非法' });
      runState.clear(sid, version);
      continue;
    }
    if (running.has(instKey(sid, version))) {
      result.skipped.push({ id: sid, version, reason: '已在运行' });
      continue;
    }
    const rec = store.get(sid, version);
    if (!rec || !rec.script) {
      result.skipped.push({ id: sid, version, reason: '版本不存在或源码为空' });
      runState.clear(sid, version);
      continue;
    }
    /* 开发模式也恢复正式实例：身份/上下文均为正式，只有设备写被 devMode 闸拦住，
     * 不会与 NAS 正式实例双份裁决抢设备（本地 HA 写不下发）。 */
    try {
      const entry = start(sid, version, connector);
      emitLog(entry, 'info', `服务重启，自动恢复运行 v${version}（运行意图清单）`);
      result.restored.push({ id: sid, version, mode: entry.dryRun ? 'shadow' : 'production' });
    } catch (e) {
      result.skipped.push({ id: sid, version, reason: e.message });
      runState.clear(sid, version);
    }
  }
  return result;
}

function onExit(entry, code) {
  clearTimeout(entry.watchdog);
  const wasRunning = running.get(entry.key) === entry;
  detachChild(entry);
  /* 旧实例退出时不能删 running 登记：跨版本发布切换会先 stop 旧实例再 start 新实例，
   * 旧进程在宽限期后才真正退出，此时 running 里已是新实例。无条件 delete 会把新实例
   * 从表里抹掉 → 进程变孤儿（还在跑、却再也停不下来，desired-running 也残留）。
   * 只有"退出的是当前登记的那个实例"才清登记。 */
  if (!wasRunning) return;
  running.delete(entry.key);
  /* simulate 实例异常退出不自动重启：start 不携带 verifyMode 会悄悄变回 follow，
   * 且虚拟世界已丢失，重启没有意义。直接终态 + error，提示用户重新进入仿真（§5.2）。 */
  if (entry.verifyMode === 'simulate') {
    runState.clear(entry.sid, entry.version);
    clearRefs(entry.key);
    const hasCrash = !!store.readSimCrash(entry.sid, entry.version);
    settleStatus(entry.sid, entry.version, {
      status: code === 0 ? 'stopped' : 'error',
      error: code === 0 ? undefined
        : `仿真实例异常退出（退出码 ${code}），虚拟世界已结束${hasCrash ? '；崩溃现场已保留，可继续调用 sim_snapshot 只读查看' : '，请重新进入仿真'}`,
      reason: code === 0 ? 'exited' : 'sim-error', entry,
    });
    return;
  }
  const cfg = getConfig();
  if (code !== 0 && entry.restarts < cfg.maxRestarts) {
    entry.restarts += 1;
    emitLog(entry, 'warn', `runner 退出码 ${code}，自动重启 ${entry.restarts}/${cfg.maxRestarts}`);
    const t = setTimeout(() => {
      pendingRestarts.delete(entry.key); // 窗口结束，登记出表
      if (running.has(entry.key)) return;
      /* 用模块级连接器 + 显式传递已累计的重启次数：
       * 旧代码调用内部 start 且不传 restarts，新 entry 计数归零 → maxRestarts 失效（M1）。 */
      try {
        start(entry.sid, entry.version, currentConnector, entry.restarts);
      } catch (e) {
        /* 重启失败也必须走终态路径：running 已删但意图清单/meta 若不清理，
         * 会出现停不掉的"幽灵运行"，下次服务重启还会反复尝试（M-审计 A1）。 */
        emitLog(entry, 'error', `自动重启失败：${e.message}`);
        runState.clear(entry.sid, entry.version);
        clearRefs(entry.key);
        settleStatus(entry.sid, entry.version, { status: 'error', error: e.message, reason: 'error', entry });
      }
    }, 500);
    pendingRestarts.set(entry.key, { timer: t, entry });
    return;
  }
  runState.clear(entry.sid, entry.version); // 最终退出（不重启）：不再恢复
  clearRefs(entry.key);
  settleStatus(entry.sid, entry.version, {
    status: code === 0 ? 'stopped' : 'error',
    error: `退出码 ${code}`, reason: code === 0 ? 'exited' : 'error', entry,
  });
}

/* 兜底可观测性：当前 HA 可用性、每实例引用实体与暂停原因、HA 状态更新入口。
 * 键 = `${scriptId}#v${version}`（同一脚本正式+影子可各一条），附 scriptId/version/mode。 */
function haStatus() {
  const out = {};
  for (const [key, entry] of running) {
    const pausedSet = entityPaused.get(key);
    out[key] = {
      scriptId: entry.sid, version: entry.version, mode: entry.dryRun ? 'shadow' : 'production',
      refs: getRefs(key), paused: !!(pausedSet && pausedSet.size), pausedBy: pausedSet ? [...pausedSet] : [],
    };
  }
  return { ha: haState, scripts: out };
}

/* 一次性脚本裁决链（ctx.call 与手动 trigger 共用）：解析通道版本 → 校验源码 →
 * 拒绝常驻自动化（防双份裁决）→ 运行中按 restartable 决定重入（停旧启新）或拒绝。
 * t 为文案集：'调用'/'触发' 两种语境的错误文案与拆分前逐字一致（测试有正则断言）。 */
function startOneShot(sid, channel, t) {
  const version = store.versionOfChannel(sid, channel);
  if (version == null) throw new Error(t.noVersion(sid, channel));
  const rec = store.get(sid, version);
  if (!rec || !rec.script) throw new Error(t.noScript);
  if (store.kindOf(rec.meta) === 'automation') throw new Error(t.automation);
  if (running.has(instKey(sid, version))) {
    if (!rec.meta.restartable) throw new Error(t.busy);
    stop(sid, 'restart', version); // 对齐 HA mode:restart：可重入目标停旧启新
  }
  return { version, rec };
}

const CALL_TEXT = {
  noVersion: (sid, ch) => {
    const label = ch === 'shadow' ? '影子' : '正式';
    return `被调脚本 ${sid} 没有${label}版本（跟随调用者的${label}模式）`;
  },
  noScript: '被调脚本源码不存在',
  automation: '只能调用动作/场景类一次性脚本（kind=script/scene）；常驻自动化请用 start 管理',
  busy: '被调脚本正在执行中，请稍后再调用',
};
const TRIGGER_TEXT = {
  noVersion: (sid, ch) => ch === 'shadow'
    ? '脚本没有影子版本，无法触发（先提交影子）'
    : '脚本没有正式版本，无法触发（请先发布）',
  noScript: '正式版本源码不存在',
  automation: '常驻自动化不能按次触发，请用 start 管理实例',
  busy: '脚本正在执行中，请稍后再触发',
};

/* 一次性触发：供 Home 面板 / ctx.call 调用脚本与场景（kind=script/scene）。
 * channel 缺省 production（Home 面板语义不变）；channel='shadow' 触发影子版本——
 * 设备写仍被执行器硬拦截只记日志，供 MCP 影子验证用。常驻自动化（kind=automation）
 * 禁止走此入口——它们由 start 管理常驻实例，手动"触发一次"会造成双份裁决。
 * 跑完自然 done 后由 handleChildMessage 清实例与运行意图。 */
function trigger(id, connector, channel) {
  const sid = String(id || '');
  if (!store.safeId(sid)) throw new Error('脚本 id 非法');
  const ch = channel === 'shadow' ? 'shadow' : 'production';
  const { version } = startOneShot(sid, ch, TRIGGER_TEXT);
  start(sid, version, connector);
  return { id: sid, version, mode: ch, devMode: DEV_MODE };
}

/* ================= 影子双模式验证：simulate 控制面（已抽出为 sim-control.js，审计 3.1）=================
 * 本模块只保留装配与回执转交：控制面函数（switchVerifyMode / sim* 12 个）与
 * simPending 私有状态都在 sim-control.js，实例生命周期仍归本模块（deps 注入）。 */
const simControl = createSimControl({
  instancesOf, store, hub, start, stop, broadcastScript, broadcastRefresh,
  emitLog, clearError, getConnector: () => currentConnector,
});
const {
  switchVerifyMode, simInject, simAdvance, simSnapshot, simRunSteps, simClose,
  simAssert, simMark, simRewind, simExport, simRunFixture, simListFixtures,
} = simControl;

module.exports = {
  start, stop, stopAll, restore, isRunning, runningVersion, runningVersions, runningList, onStateChange,
  acquireAction, releaseAction, submitScript, rollback, publish, removeVersion, removeScript, trigger,
  onHaReady, onHaOffline, haStatus, writeAllowed, broadcastRefresh,
  versionRuntimeStatus, scriptRuntimeStatus, statusSummary,
  switchVerifyMode, simInject, simAdvance, simRunSteps, simSnapshot, simClose,
  simAssert, simMark, simRewind, simExport, simRunFixture, simListFixtures,
};
