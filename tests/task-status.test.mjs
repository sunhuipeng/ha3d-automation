'use strict';
/* ctx.task 原语测试（status / require；订阅类 ctx.task.watch 已删除，状态订阅统一走
 * ctx.global.watch 写者折叠通道）：
 * ① runner 层用 mock 宿主验证 scriptId、require 门闩/超时/stop 中断；
 * ② executor 层用真实 fork + mock connector 验证影子优先、影子实例未起回退正式、
 *    正式观察者看不见影子实例（通道规则由主进程裁决）。全程不连接真实 HA。 */
import { createRequire } from 'node:module';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, '../server/scripts/runner.js');

/* ---------- runner 层 mock 宿主 ---------- */
function runWithMockHost(script, { meta = {}, onRequest } = {}) {
  return new Promise((resolve) => {
    const child = fork(RUNNER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, HA3D_RUNNER: '1' } });
    const logs = [];
    const hostMsgs = [];
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch (e) {}
      resolve({ logs, hostMsgs, text: logs.map((l) => l.message).join('\n') });
    };
    child.on('message', (msg) => {
      hostMsgs.push(msg);
      if (msg.type === 'request') {
        Promise.resolve()
          .then(() => onRequest ? onRequest(msg.action, msg.data, child) : null)
          .then((result) => child.send({ type: 'reply', id: msg.id, ok: true, result }))
          .catch((e) => child.send({ type: 'reply', id: msg.id, ok: false, error: String(e && e.message || e) }));
      }
      if (msg.type === 'log') logs.push(msg);
      if (msg.type === 'done') finish();
    });
    timer = setTimeout(finish, 8000);
    child.send({ type: 'run', script, meta: { version: 1, dryRun: true, sid: 'self', ...meta } });
  });
}

test('ctx.scriptId / ctx.task.status：取到 executor 注入的权威 sid，状态查询走 taskStatus 请求', async () => {
  const actions = [];
  const { text } = await runWithMockHost(`
    ctx.log('info', 'SID:' + ctx.scriptId);
    const st = await ctx.task.status('dep');
    ctx.log('info', 'STATUS:' + st.state + ':' + st.version);
  `, {
    onRequest: (action, data) => {
      actions.push({ action, scriptId: data.scriptId });
      return { scriptId: 'dep', version: 2, mode: 'production', state: 'running', info: {} };
    },
  });
  assert.match(text, /SID:self/);
  assert.match(text, /STATUS:running:2/);
  assert.deepEqual(actions, [{ action: 'taskStatus', scriptId: 'dep' }]);
});

test('ctx.task.watch 已删除：调用应抛错（订阅统一走 ctx.global.watch 写者折叠）', async () => {
  const { text } = await runWithMockHost(`
    try { ctx.task.watch('dep', () => {}); ctx.log('info', 'NO_ERROR'); }
    catch (e) { ctx.log('info', 'GONE:' + e.message); }
  `);
  assert.doesNotMatch(text, /NO_ERROR/, 'ctx.task.watch 不应存在');
  assert.match(text, /watch is not a function|Cannot read|GONE:/, '调用必然失败');
});

test('ctx.task.require：依赖未起时轮询等待，状态变 running 后一次性返回', async () => {
  let up = false;
  let calls = 0;
  const { text } = await runWithMockHost(`
    const dep = await ctx.task.require('dep', { timeout: 3000 });
    ctx.log('info', 'REQ:' + dep.state + ':' + dep.mode);
  `, {
    onRequest: () => {
      calls += 1;
      if (calls >= 2) up = true; // 第二次轮询起依赖已就绪（模拟 200ms 内启动完成）
      return { scriptId: 'dep', version: 1, mode: 'shadow', state: up ? 'running' : 'stopped', info: {} };
    },
  });
  assert.match(text, /REQ:running:shadow/);
  assert.ok(calls >= 2, `require 应多次轮询（实际 ${calls} 次）`);
});

test('ctx.task.require：超时 reject；stop 中断等待', async () => {
  const timeoutRun = await runWithMockHost(`
    try { await ctx.task.require('dep', { timeout: 120 }); }
    catch (e) { ctx.log('info', 'TIMEOUT:' + e.message); }
  `, { onRequest: () => ({ state: 'stopped', info: {} }) });
  assert.match(timeoutRun.text, /TIMEOUT:等待依赖脚本 dep 超时/);

  let stopScheduled = false;
  const stopRun = await runWithMockHost(`
    try { await ctx.task.require('dep', { timeout: 8000 }); }
    catch (e) { ctx.log('info', 'STOPPED:' + e.message); }
  `, {
    onRequest: (action, data, child) => {
      if (!stopScheduled) { stopScheduled = true; setTimeout(() => child.send({ type: 'stop' }), 60); }
      return { state: 'stopped', info: {} };
    },
  });
  assert.match(stopRun.text, /STOPPED:脚本已停止，取消等待依赖 dep/);
});

/* ---------- executor 层端到端 ---------- */
const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-taskstatus-'));
const config = require('../server/config');
config.DATA = tmpRoot; // 必须在 require store/executor 之前覆盖
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
const connector = {
  demo: false,
  getState: () => ({ state: 'off', attributes: {} }),
  listEntities: () => [],
  callService: async () => ({ ok: true }),
};
const STATUS_SCRIPT = `
  ctx.log('info', 'SID:' + ctx.scriptId);
  const st0 = await ctx.task.status('taskdep');
  ctx.log('info', 'ST0:' + st0.state + ':' + st0.mode);
  let dep = null;
  try { dep = await ctx.task.require('taskdep', { timeout: 3000 }); }
  catch (e) { ctx.log('info', 'TIMEOUT:' + e.message); }
  if (dep) ctx.log('info', 'REQ:' + dep.state + ':' + dep.mode + ':v' + dep.version);
  ctx.log('info', 'DONE');
`;

function waitDone(sid, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (!executor.isRunning(sid)) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('等待脚本结束超时：' + sid));
      setTimeout(tick, 50);
    };
    tick();
  });
}
function logsOf(sid, version) {
  return store.readLogs(sid, version).map((l) => String(l.message || '')).join('\n');
}
function waitForLog(sid, version, re, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const text = logsOf(sid, version);
      if (re.test(text)) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('等待日志超时：' + sid + ' / ' + re));
      setTimeout(tick, 30);
    };
    tick();
  });
}
function submitWatcher(sid, channel) {
  return store.submit(sid, { name: sid, script: STATUS_SCRIPT, flow: FLOW, channel });
}

after(() => { executor.stopAll(); });

test('统一读正式实例：影子观察者忽略影子依赖，等正式实例启动', async () => {
  const depShadow = store.submit('taskdep', {
    name: '依赖', script: 'await ctx.keepAlive();', flow: FLOW, kind: 'automation', channel: 'shadow',
  });
  const depProd = store.submit('taskdep', {
    name: '依赖', script: 'await ctx.keepAlive();', flow: FLOW, kind: 'automation', channel: 'production',
  });
  executor.start('taskdep', depShadow.version, connector); // 影子依赖先跑，观察者也必须无视它
  const w = submitWatcher('taskstatus1', 'shadow');

  executor.start('taskstatus1', w.version, connector);
  /* 必须等观察者的首次 status 真正落地再启动正式依赖：fork 子进程启动晚于 start() 返回，
   * 固定 sleep 会偶发"依赖先起"使回放状态变成 running，掩盖 waiting 路径。 */
  await waitForLog('taskstatus1', w.version, /ST0:stopped:production/);
  executor.start('taskdep', depProd.version, connector);
  await waitDone('taskstatus1');

  const text = logsOf('taskstatus1', w.version);
  assert.match(text, /SID:taskstatus1/, 'ctx.scriptId 应为 executor 注入的 id');
  assert.match(text, /ST0:stopped:production/, '影子实例在跑不算依赖就绪');
  assert.match(text, /REQ:running:production:v2/);
});

test('统一读正式实例：正式依赖已在跑时，影子观察者直接拿到正式状态', async () => {
  const prodVersion = store.versionOfChannel('taskdep', 'production');
  assert.equal(executor.isRunning('taskdep'), true, '正式实例应仍在运行');

  const w = submitWatcher('taskstatus2', 'shadow');
  executor.start('taskstatus2', w.version, connector);
  await waitDone('taskstatus2');

  const text = logsOf('taskstatus2', w.version);
  assert.match(text, /ST0:running:production/);
  assert.match(text, /REQ:running:production:v2/);
  assert.doesNotMatch(text, /:shadow:/, '所有状态都应是正式实例口径');
});

test('影子实例在跑不算依赖就绪：require 超时', async () => {
  executor.stop('taskdep'); // 全停
  await new Promise((r) => setTimeout(r, 150));
  const depShadow = store.versionOfChannel('taskdep', 'shadow');
  executor.start('taskdep', depShadow, connector);
  assert.equal(executor.isRunning('taskdep'), true);

  const w = submitWatcher('taskstatus3', 'production');
  executor.start('taskstatus3', w.version, connector);
  await waitDone('taskstatus3');

  const text = logsOf('taskstatus3', w.version);
  assert.match(text, /ST0:stopped:production/);
  assert.match(text, /TIMEOUT/, '影子实例在跑时正式依赖仍算未起，require 应超时');
  assert.doesNotMatch(text, /REQ:/);
});
