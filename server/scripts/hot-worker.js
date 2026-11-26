'use strict';
/* 热池 worker 入口：常驻线程 + 会话多路复用。
 * 与 worker-runner.js（每脚本一个线程、跑完即毁）不同，本线程由 hot-pool.js 常驻，
 * 每个一次性脚本触发 = 一个新 session = 一个全新 createCore 实例：
 *   - realm / ctx 闭包 / 受控定时器表 / 锁表 / writeStats / suspended / waiting Map
 *     全部收敛在各会话的 createCore 闭包里 → 会话之间结构性零状态残留；
 *   - 触发成本 ≈ 一次 postMessage，无线程创建；
 *   - 会话结束（done 后主进程发 end，或被 kill 兜底）调用 core.destroy() 彻底清场。
 *
 * 消息协议（宿主 → 本线程）：{ type:'hotSession', id, op, msg }
 *   op='run' : msg = { type:'run', script, meta }   新建会话并启动脚本
 *   op='msg' : msg = runner-core 协议消息（reply/state/contextChange/taskState/…）
 *   op='end' : 销毁会话（destroy + 出表）
 * 本线程 → 宿主：{ type:'hotSession', id, op:'msg', msg }（msg 为 runner-core 协议消息）
 *
 * 卡死边界：顶层同步死循环被 vm timeout 中断（done 逸出）；回调死循环被 guardedCall
 * 的 V8 timeout 中断——线程级 stall 实际不可达，软超时走协作让步（stop → destroy 兜底）。 */
const { parentPort } = require('worker_threads');
const { createCore } = require('./runner-core');

if (!parentPort) throw new Error('hot-worker.js 只能在 worker_threads 内运行');

const sessions = new Map(); // sessionId -> core 实例

parentPort.on('message', (env) => {
  if (!env || env.type !== 'hotSession') return;
  const { id, op, msg } = env;
  if (op === 'run') {
    if (sessions.has(id)) return; // 防御：主进程保证 id 唯一（seq 递增）
    const core = createCore({
      emit: (m) => { try { parentPort.postMessage({ type: 'hotSession', id, op: 'msg', msg: m }); } catch (e) {} },
    });
    sessions.set(id, core);
    try { core.handleMessage(msg); } catch (e) {
      parentPort.postMessage({ type: 'hotSession', id, op: 'msg', msg: { type: 'done', ok: false, error: '会话启动失败：' + (e && e.message || e) } });
    }
    return;
  }
  const core = sessions.get(id);
  if (!core) return; // 会话已被清理：迟到的消息直接丢弃
  if (op === 'msg') {
    try { core.handleMessage(msg); } catch (e) {}
    return;
  }
  if (op === 'end') {
    core.destroy();
    sessions.delete(id);
  }
});

/* 防崩兜底：与会话相关的异常已由 createCore 内部捕获；这里兜住会话之外的意外，
 * 只记日志不退出线程（退出会殃及全部并发会话，必须极端情况才发生）。 */
process.on('unhandledRejection', (e) => {
  parentPort.postMessage({ type: 'hotLog', level: 'error', message: '[热池] 未捕获的 Promise 拒绝：' + (e && e.message || e) });
});
process.on('uncaughtException', (e) => {
  parentPort.postMessage({ type: 'hotLog', level: 'error', message: '[热池] 未捕获异常：' + (e && e.message || e) });
});
