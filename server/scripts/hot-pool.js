'use strict';
/* 热池（hot pool）：一次性脚本专用常热 worker。
 * 只服务 kind=script/scene 的正式通道且未显式指定 meta.hostMode 的实例（选择逻辑在
 * executor.start）；影子仍强制专属 worker（每次新建、用完即毁，隔离优先于性能）。
 *
 * 每个脚本会话 = worker 内一个全新 runner-core 实例（realm/ctx/定时器/锁/统计全部
 * 会话私有，结构性零残留）；触发即取空闲槽位，成本 ≈ 一次 postMessage。
 * 并发上限（默认 4 会话/worker）：满则返回 null，executor 降级为「每次新建 worker」
 * ——退化为现状行为，不排队不阻塞。热 worker 数量默认 1，可扩到 N（完整热池形态）。
 *
 * 卡死边界：顶层同步死循环被 vm timeout 中断、回调死循环被 guardedCall V8 timeout
 * 中断，线程级 stall 实际不可达；软超时走协作让步（stop → destroy 兜底），terminate
 * 仅在 worker 崩溃重建时发生。内存失控由 resourceLimits 兜底：worker 被 V8 终止时
 * 所有会话按崩溃路径 exit(1) 上抛，与 fork 崩溃语义一致。 */
const path = require('path');
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');

const HOT_WORKER_PATH = path.join(__dirname, 'hot-worker.js');
const DEFAULT_POOL_SIZE = 1;
const DEFAULT_MAX_SESSIONS = 4;
/* 空闲回收：worker 连续 IDLE_MS 无任何会话且无触发 → terminate 销毁（下次触发懒重建）。
 * 0 = 禁用回收（常驻热 worker）。动作/场景典型低频，回收让空闲时段内存归零。 */
const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const RESOURCE_LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 };

const envNum = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
};
const poolSize = Math.max(1, envNum('HA3D_HOT_POOL_SIZE', DEFAULT_POOL_SIZE));
const maxSessions = Math.max(1, envNum('HA3D_HOT_MAX_SESSIONS', DEFAULT_MAX_SESSIONS));
const idleMs = envNum('HA3D_HOT_IDLE_MS', DEFAULT_IDLE_MS);

const workers = [];      // [{ w, sessions: Map<sessionId, handle>, lastUsedAt }]
let seq = 0;
let started = false;
let reaper = null;       // 空闲回收定时器（池空即停，下次 spawn 再起）

function log(level, message) {
  if (level === 'error') console.error(`[hot-pool] ${message}`);
  else console.log(`[hot-pool] ${message}`);
}

/* 空闲回收：只收割「无任何会话且超过 IDLE_MS 无活动」的 worker。
 * 主进程单线程事件循环内同步判断，无竞态：收割出表后下一个触发自然走懒创建重建。
 * 有会话在跑绝不动（busy 不误杀）；IDLE_MS=0 时整个收割机制不启用。 */
function ensureReaper() {
  if (reaper || idleMs === 0) return;
  const scanMs = Math.min(Math.max(Math.floor(idleMs / 4), 100), 30000);
  reaper = setInterval(() => {
    const now = Date.now();
    for (const st of [...workers]) {
      if (st.sessions.size === 0 && now - st.lastUsedAt >= idleMs) {
        const idx = workers.indexOf(st);
        if (idx >= 0) workers.splice(idx, 1);
        st.w.terminate(); // 会话为空，exit 不殃及任何脚本；下次触发懒重建
        log('info', `空闲 ${Math.round(idleMs / 1000)}s 无会话，worker 已销毁（下次触发懒重建）`);
      }
    }
    if (workers.length === 0) { clearInterval(reaper); reaper = null; } // 池空停扫，不空转
  }, scanMs);
  reaper.unref(); // 不阻碍进程自然退出
}

/* 创建一个热 worker 并挂好消息路由 */
function spawnWorker(env) {
  const w = new Worker(HOT_WORKER_PATH, {
    env: env || undefined,
    stdout: true,
    stderr: true,
    resourceLimits: RESOURCE_LIMITS,
  });
  const state = { w, sessions: new Map(), lastUsedAt: Date.now() };
  w.on('message', (m) => {
    if (m && m.type === 'hotSession') {
      const sess = state.sessions.get(m.id);
      if (!sess) return; // 迟到消息：会话已被清理
      sess.handle.emit('message', m.msg);
      return;
    }
    if (m && m.type === 'hotLog') log(m.level, m.message);
  });
  w.on('error', (e) => {
    log('error', 'worker error：' + (e && e.message || e));
  });
  w.on('exit', (code) => {
    // 崩溃/被 terminate：所有未结会话按 exit(1) 上抛（executor onExit 按崩溃语义处理）
    const live = state.sessions.size;
    for (const sess of state.sessions.values()) {
      try { sess.handle.emit('exit', 1); } catch (e) {}
    }
    state.sessions.clear();
    const idx = workers.indexOf(state);
    if (idx >= 0) workers.splice(idx, 1);
    log('error', `worker 退出（code=${code}），${live} 个存活会话已按崩溃处理，池将在下次触发时重建`);
  });
  workers.push(state);
  /* unref：热 worker 不阻碍宿主进程自然退出（服务主循环由 HTTP/WS 维持，不受影响；
   * 测试进程跑完用例即可干净退出，worker 随进程消亡）。 */
  try { w.unref(); } catch (e) {}
  return state;
}

/* 取一个会话槽位。返回 ChildProcess 同形状句柄；无可用槽位返回 null（executor 降级）。
 * 选择顺序：有空闲槽位的 worker → 新建（未达 poolSize）→ null。 */
function acquireSession({ env } = {}) {
  if (!started) { started = true; log('info', `热池启动：poolSize=${poolSize} maxSessions=${maxSessions} idleMs=${idleMs === 0 ? '禁用回收' : idleMs + 'ms'}`); }
  let st = workers.find((x) => x.w && x.sessions.size < maxSessions);
  if (!st && workers.length < poolSize) { st = spawnWorker(env); ensureReaper(); }
  if (!st || st.sessions.size >= maxSessions) return null;
  st.lastUsedAt = Date.now();
  const id = `s${++seq}`;
  const handle = new EventEmitter();
  const sess = { handle };
  st.sessions.set(id, sess);
  /* run 消息触发 worker 侧会话创建（op:'run'）；其余协议消息走 op:'msg' 路由进已有会话 */
  handle.send = (msg) => {
    if (msg && msg.type === 'run') {
      try { st.w.postMessage({ type: 'hotSession', id, op: 'run', msg }); } catch (e) {}
      return;
    }
    try { st.w.postMessage({ type: 'hotSession', id, op: 'msg', msg }); } catch (e) {}
  };
  /* kill = 结束会话：worker 侧 destroy 清场 + 出表释放槽位（幂等） */
  handle.kill = () => {
    if (!st.sessions.has(id)) return true;
    st.sessions.delete(id);
    st.lastUsedAt = Date.now(); // 从最后一个会话释放起算空闲窗口
    try { st.w.postMessage({ type: 'hotSession', id, op: 'end' }); } catch (e) {}
    return true;
  };
  handle.stdout = { on() {} };
  handle.stderr = { on() {} };
  handle.hotSession = true;
  handle.sessionId = id;
  return handle;
}

function stats() {
  return { poolSize, maxSessions, idleMs, workers: workers.length, sessions: workers.reduce((n, x) => n + x.sessions.size, 0) };
}

/* 服务停机：terminate 全部热 worker（会话随 exit(1) 走崩溃路径） */
function shutdown() {
  for (const st of [...workers]) { try { st.w.terminate(); } catch (e) {} }
}

module.exports = { acquireSession, stats, shutdown, POOL_SIZE: poolSize, MAX_SESSIONS: maxSessions, IDLE_MS: idleMs };
