'use strict';
/* worker 宿主的 executor 侧句柄：把 worker_threads.Worker 适配成与 ChildProcess
 * 同形状（send / on('message') / kill / stdout / stderr / exit / error），
 * executor 上层生命周期逻辑零改动。
 *   send(msg)          → postMessage（消息全是可克隆普通对象，无序列化改造）
 *   kill()             → terminate()：抢占式强杀，能杀 vm timeout 拦不住的异步续体
 *   stdout/stderr      → Worker 自带流（stdout:true / stderr:true 选项）
 *   exit               → Worker 'exit'（terminate 后 exitCode=1；stopInstance 已先摘除登记，不会误触发重启） */
const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_PATH = path.join(__dirname, 'worker-runner.js');

/* env：调用方传 childEnv()（剔除 HA_TOKEN），与 fork 的敏感信息剥离策略一致。
 * resourceLimits：堆上限兜底，堆炸弹只废自己的线程而不吃满宿主内存。 */
/* send 与 ChildProcess.send 同语义：失败要让调用方看见（executor 侧需要兜底的地方
 * 都已自带 try/catch），静默吞掉会让 sim 回执丢失、只能靠 10s 超时兜底才发现。 */
function createWorkerChild({ env } = {}) {
  const w = new Worker(WORKER_PATH, {
    env: env || undefined,
    stdout: true,
    stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
  });
  w.send = (msg) => { w.postMessage(msg); return true; };
  w.kill = () => { try { w.terminate(); } catch (e) {} return true; };
  w.worker = true;
  return w;
}

module.exports = { createWorkerChild };
