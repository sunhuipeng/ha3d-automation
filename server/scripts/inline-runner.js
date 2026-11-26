'use strict';
/* inline 宿主：把 runner-core 伪装成 child_process 句柄交给 executor，
 * 实现 EXECUTION_MODE=inprocess 单进程执行（省掉每脚本一个子进程的内存开销）。
 *
 * 消息流与 fork 模式完全一致（executor 上层逻辑零改动）：
 *   core emit { log | subscribe | request | done } → executor.handleChildMessage
 *   executor send { run | reply | state | mode | suspend | resume | stop } → core.handleMessage
 *
 * 与 fork 的差异与补偿：
 *   - 没有进程隔离：脚本回调经 runner-core 的 guardedCall（V8 timeout）防同步死循环，
 *     主进程最多被卡 cbTimeoutMs（默认 2s）而不是永远；
 *   - 没有 uncaughtException 兜底：模块加载时在主进程挂一次全局兜底，只记日志不退出。 */
const { EventEmitter } = require('events');
const { createCore } = require('./runner-core');

/* 主进程全局兜底（幂等）：inline 模式下脚本 fire-and-forget 的 reject 若无全局处理
 * 会让服务进程崩掉，比 fork 模式（只崩一个子进程）严重得多，必须只记日志。 */
function installGlobalGuards() {
  if (process.listenerCount('unhandledRejection') === 0) {
    process.on('unhandledRejection', (e) => {
      console.error('[inline-runner] 未捕获的 Promise 拒绝：', e && e.message || e);
    });
  }
  if (process.listenerCount('uncaughtException') === 0) {
    process.on('uncaughtException', (e) => {
      console.error('[inline-runner] 未捕获异常：', e && e.message || e);
    });
  }
}

/* 返回与 child_process.ChildProcess 同形状的句柄（继承 EventEmitter，
 * on / once / removeListener / emit 全部可用），executor 上层零改动。 */
function createInlineChild() {
  installGlobalGuards();
  const handle = new EventEmitter();
  const core = createCore({ emit: (msg) => handle.emit('message', msg) });
  handle.send = (msg) => {
    try { core.handleMessage(msg); } catch (e) {
      handle.emit('message', { type: 'log', level: 'error', message: 'inline 消息处理异常：' + (e && e.message || e) });
    }
  };
  /* 宽限期兜底：清定时器 + 让脚本让步（与 fork 的 SIGTERM 对应），幂等 */
  handle.kill = () => { try { core.handleMessage({ type: 'stop' }); } catch (e) {} return true; };
  handle.stdout = { on() {} };
  handle.stderr = { on() {} };
  handle.inline = true;
  return handle;
}

module.exports = { createInlineChild };
