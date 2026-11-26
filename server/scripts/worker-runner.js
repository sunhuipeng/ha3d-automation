'use strict';
/* worker 宿主入口：runner-core + parentPort 桥。与 runner.js（fork）逻辑同构。
 * 每个脚本一个 worker 线程：OS 抢占式调度（坏脚本只烧自己的线程，主线程
 * 永不执行脚本代码）；terminate() 可杀 vm timeout 拦不住的异步续体。
 * EXECUTION_MODE=worker 时由 executor 的 createWorkerChild 启动本文件。 */
const { parentPort } = require('worker_threads');
const { createCore } = require('./runner-core');

if (!parentPort) throw new Error('worker-runner.js 只能在 worker_threads 内运行');

const core = createCore({ emit: (msg) => parentPort.postMessage(msg) });
parentPort.on('message', (msg) => core.handleMessage(msg));

/* 防崩兜底：worker 内未捕获异常会直接终止线程（exit 1 → 触发主进程按 maxRestarts
 * 重启）。这里只记日志不退出，与 fork 宿主的兜底语义一致，避免重启风暴。 */
process.on('unhandledRejection', (e) => {
  parentPort.postMessage({ type: 'log', level: 'error', message: '未捕获的 Promise 拒绝：' + (e && e.message || e) });
});
process.on('uncaughtException', (e) => {
  parentPort.postMessage({ type: 'log', level: 'error', message: '未捕获异常：' + (e && e.message || e) });
});
