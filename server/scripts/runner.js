'use strict';
/* fork 宿主入口：runner-core + IPC 桥。脚本作为数据从 IPC 注入，绝不 require 用户脚本。
 * 执行核心在 runner-core.js（与 inline-runner.js 共用同一套执行语义）；
 * 每个脚本一个子进程：卡死由进程隔离兜底，看门狗/崩溃重启在主进程 executor。
 * EXECUTION_MODE=inprocess 时改走 inline-runner.js（单进程，省子进程内存）。 */
const { createCore } = require('./runner-core');

const core = createCore({ emit: (msg) => { if (process.send) process.send(msg); } });

process.on('message', (msg) => core.handleMessage(msg));

/* 防崩兜底：脚本里 fire-and-forget 的 promise（如 ctx.ha.entity().then(...) 漏 catch）
 * 在 Node ≥15 默认会直接 crash runner → 触发主进程重启风暴。这里只记日志不退出，
 * 让脚本自身的正常结束/异常路径决定生命周期。 */
process.on('unhandledRejection', (e) => {
  if (process.send) process.send({ type: 'log', level: 'error', message: '未捕获的 Promise 拒绝：' + (e && e.message || e) });
});
process.on('uncaughtException', (e) => {
  if (process.send) process.send({ type: 'log', level: 'error', message: '未捕获异常：' + (e && e.message || e) });
});
