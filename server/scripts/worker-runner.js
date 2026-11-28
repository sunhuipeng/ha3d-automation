'use strict';
/* worker 宿主入口：runner-core + parentPort 桥。与 runner.js（fork）逻辑同构。
 * 每个脚本一个 worker 线程：OS 抢占式调度（坏脚本只烧自己的线程，主线程
 * 永不执行脚本代码）；terminate() 可杀 vm timeout 拦不住的异步续体。
 *
 * simulate 模式：meta.simulate 时在本线程创建 VirtualClock + SimSession，
 * core 的 request 由 sim-host 在微任务内闭环应答（不跨 IPC），保证 advance 快进
 * 不会误触发 request 的 10s 超时（SIMULATION-DESIGN §4）。控制消息 simInject /
 * simAdvance / simSnapshot 由主进程下发，simReply 回执。 */
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { createCore } = require('./runner-core');
const { VirtualClock } = require('../sim/clock');
const { createSimSession } = require('../sim/session');

if (!parentPort) throw new Error('worker-runner.js 只能在 worker_threads 内运行');

let core = null;
let session = null;
let simLog = null;
let crashFile = null;        // meta.simCrashFile：崩溃只读快照落点（§5.2）
let crashWritten = false;
let intentionalStop = false; // 收到 stop/simClose：正常结束，不写崩溃现场

/* 仿真日志独立文件（§5）：逐行 JSON 追加写，与线上 v<n>.log 分开。
 * 只在 simulate worker 打开（meta.simLogFile 由主进程按仓库路径规则下发）。
 * 会话开始时的清空由主进程 start(simulate) 统一做（store.clearSimLog）——
 * 这里必须用 'a' 追加：否则会抹掉主进程先落的框架日志（如 [模式切换]）。 */
function openSimLog(file) {
  closeSimLog();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    simLog = fs.createWriteStream(file, { flags: 'a' });
    simLog.on('error', () => { simLog = null; });
  } catch (e) { simLog = null; }
}
function writeSimLog(level, message, nodeId) {
  if (!simLog) return;
  try {
    const at = session ? session.clock.elapsedMs() : 0;
    simLog.write(JSON.stringify({ ts: Date.now(), at, level: level || 'info', message: String(message || ''), nodeId: nodeId || undefined }) + '\n');
  } catch (e) { /* 日志写失败不影响仿真 */ }
}
function closeSimLog() {
  try { if (simLog) { simLog.end(); simLog = null; } } catch (e) { simLog = null; }
}

/* 崩溃现场：同步写盘（退出前没有异步窗口），只写一次。
 * 必须在 postMessage(done:false) 之前落盘——主进程收到 done 会立刻 cleanup/kill，
 * 之后再想序列化虚拟世界已经没有机会了。 */
function writeCrashSnapshot(reason) {
  if (!session || !crashFile || crashWritten) return;
  crashWritten = true;
  try {
    const snap = session.snapshot({ entityScope: 'all', coreState: () => (core ? core.simState() : {}) });
    const payload = {
      ...snap,
      crashed: true, readOnly: true, crashReason: reason,
      crashedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(crashFile), { recursive: true });
    fs.writeFileSync(crashFile, JSON.stringify(payload), 'utf8');
  } catch (e) { /* 快照失败不能影响错误上报 */ }
}

/* core → 宿主：simulate 下 request/simWrite/log 本地消费，订阅类不下发真实表；
 * 其余消息照常 postMessage 给主进程。 */
function emit(msg) {
  /* 脚本异常终止（done:false）＝仿真的「崩溃」：主进程随即 kill 本 worker，
   * 先同步留现场，AI 事后还能看写意图与终值。 */
  if (session && msg && msg.type === 'done' && msg.ok === false) writeCrashSnapshot('script-error');
  if (session) {
    if (msg.type === 'request') {
      const reply = session.request(msg);
      Promise.resolve().then(() => core.handleMessage(reply));
      return;
    }
    if (msg.type === 'simWrite') {
      session.recordWrite(msg);          // 写意图进会话快照（归因 §6）
      parentPort.postMessage(msg);       // 同时上报，供主进程记诊断日志
      return;
    }
    if (msg.type === 'log') {
      const at = session.clock.elapsedMs();   // 虚拟时刻：前端仿真日志按 +Xs 显示，而不是墙钟
      session.recordLog(msg);                 // 日志进会话快照 + 独立文件；不落版本日志
      writeSimLog(msg.level, msg.message, msg.nodeId);
      parentPort.postMessage({ ...msg, at }); // 实时广播（带 at），主进程按 verifyMode 不落版本日志
      return;
    }
    /* 仿真不进真实订阅表（§9）：实体/上下文订阅在 worker 内由 core 自己管。 */
    if (msg.type === 'subscribe' || msg.type === 'contextSubscribe' || msg.type === 'contextUnsubscribe') return;
  }
  parentPort.postMessage(msg);
}

function reply(id, ok, result, error) {
  parentPort.postMessage({ type: 'simReply', id, ok, result, error });
}

/* 仿真控制消息表驱动：type -> (msg, session, core) => 结果（同步值或 Promise 统一）。
 * 新增 sim 消息只需在表里加一行，不再复制「查 session → 调方法 → reply」的样板。 */
const SIM_HANDLERS = {
  simInject: (msg, s) => s.inject(msg.payload),
  simAdvance: (msg, s) => s.advance(msg.ms),
  simRunSteps: (msg, s, c) => s.runSteps(msg.steps || [], {
    failFast: msg.failFast === true,
    coreState: () => (c ? c.simState() : {}),
  }),
  simSnapshot: (msg, s, c) => s.snapshot({ ...(msg.opts || {}), coreState: () => (c ? c.simState() : {}) }),
  simAssert: (msg, s, c) => s.assertNow(msg.step || {}, { since: msg.since, coreState: () => (c ? c.simState() : {}) }),
  simMark: (msg, s) => s.mark(msg.name),
  simRewind: (msg, s) => s.rewind(msg.mark),
  simExport: (msg, s) => s.exportCase(),
};

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'run') {
    const meta = msg.meta || {};
    if (meta.simulate === true) {
      const clock = new VirtualClock({ startAt: meta.simStartAt });
      openSimLog(meta.simLogFile);
      crashFile = meta.simCrashFile || null;
      crashWritten = false;
      intentionalStop = false;
      session = createSimSession({
        scriptId: meta.sid,
        startAt: meta.simStartAt,
        seed: meta.simSeed,
        clock, // 与 core 共用同一虚拟时钟，否则 advance 推不动脚本定时器
        dispatch: (m) => { if (core) core.handleMessage(m); },
        onControlLog: (m) => {
          if (m && m.type === 'log') writeSimLog(m.level, m.message, m.nodeId);
        },
      });
      core = createCore({ emit, clock });
    } else {
      session = null;
      closeSimLog();
      core = createCore({ emit });
    }
    core.handleMessage(msg);
    return;
  }
  const handler = SIM_HANDLERS[msg.type];
  if (handler) {
    if (!session) return reply(msg.id, false, null, '当前不是仿真实例');
    const s = session;   // 捕获当下引用：等待期间 simClose 置空也不影响本次应答
    const c = core;
    Promise.resolve()
      .then(() => handler(msg, s, c))
      .then((result) => reply(msg.id, true, result))
      .catch((e) => reply(msg.id, false, null, e && e.message || String(e)));
    return;
  }
  if (msg.type === 'simClose') {
    intentionalStop = true;
    if (session) { session.destroy(); session = null; }
    closeSimLog();
    return reply(msg.id, true, { closed: true });
  }
  /* 主动停止（切模式/手动 stop）也是正常收尾：不写崩溃现场，避免每次切换都留一份陈旧文件。 */
  if (msg.type === 'stop') intentionalStop = true;
  if (core) core.handleMessage(msg);
});

/* 防崩兜底：worker 内未捕获异常会直接终止线程（exit 1 → 触发主进程按 maxRestarts
 * 重启）。这里只记日志不退出，与 fork 宿主的兜底语义一致，避免重启风暴。
 * simulate 实例异常退出由主进程 onExit 特殊处理：不重启、直接 stopped + error（§5.2）。 */
process.on('unhandledRejection', (e) => {
  parentPort.postMessage({ type: 'log', level: 'error', message: '未捕获的 Promise 拒绝：' + (e && e.message || e) });
});
process.on('uncaughtException', (e) => {
  /* 未捕获异常说明执行流已断：仿真留现场（尽力而为），follow 行为不变。 */
  if (session && !intentionalStop) writeCrashSnapshot('uncaught-exception');
  parentPort.postMessage({ type: 'log', level: 'error', message: '未捕获异常：' + (e && e.message || e) });
});
/* 线程正常退出兜底（terminate/kill 不保证触发，主路径靠 done:false 同步落盘）。 */
process.on('exit', () => {
  if (session && !intentionalStop) writeCrashSnapshot('exit');
});
