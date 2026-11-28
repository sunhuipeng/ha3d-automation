'use strict';
/* stop 治理专项测试（2026-11-28）：
 * ① dispatchState：stop 后到达的 state 消息不触发 ctx.watch 回调。
 * ② dispatchGlobalChange：stop 后到达的 contextChange(global) 不触发 global.watch 回调。
 * ③ dispatchWriterState：stop 后到达的 contextWriterState 不触发 global.watch 回调。
 * ④ ctx.sleep：改走 scheduleTimer 后，stop 会清掉句柄、不再唤醒续体（原来是裸 setTimeout 不可清）。
 * ⑤ executor：stopInstance 标记 entry.stopped 后，在途 callService 不下发（connector 0 次）。
 * runner 侧用 mock 宿主，不连真实 HA；executor 侧沿用 executor-shadow-guard 的 mock connector 模式。 */
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, '../server/scripts/runner.js');

/* 通用 mock runner 宿主：脚本跑起来后，在 injectAt 注入一条消息，
 * 再从 test 侧控制是否先发 stop。返回全部日志。 */
function runWithHost(script, { inject, injectAt = 120, stopBefore = false, stopAt = 40, stopDelay = 0 } = {}) {
  return new Promise((resolve) => {
    const child = fork(RUNNER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, HA3D_RUNNER: '1' } });
    const logs = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(injTimer);
      clearTimeout(stopTimer);
      try { child.kill(); } catch (e) {}
      resolve({ text: logs.map((l) => l.message).join('\n') });
    };
    let injTimer = null;
    let stopTimer = null;
    child.on('message', (msg) => {
      if (msg.type === 'log') logs.push(msg);
      if (msg.type === 'request') child.send({ type: 'reply', id: msg.id, ok: true, result: null });
      if (msg.type === 'done') finish();
    });
    const timer = setTimeout(finish, 3000);
    if (stopBefore || stopDelay) {
      stopTimer = setTimeout(() => child.send({ type: 'stop' }), stopAt);
    }
    if (inject) {
      injTimer = setTimeout(() => {
        child.send(inject);
        if (stopDelay) setTimeout(() => child.send({ type: 'stop' }), stopDelay);
      }, injectAt);
    }
    child.send({ type: 'run', script, meta: { version: 1, dryRun: true, sid: 'self' } });
  });
}

test('dispatchState：stop 后到达的实体状态不再触发 ctx.watch 回调', async () => {
  const { text } = await runWithHost(`
    ctx.watch(['sensor.x'], (s) => ctx.log('info', 'CB:' + (s && s.state)));
    await ctx.keepAlive();
  `, { inject: { type: 'state', entityId: 'sensor.x', state: 'on', prev: 'off' }, stopBefore: true, stopAt: 40, injectAt: 120 });
  assert.doesNotMatch(text, /CB:/, 'stopped 后 state 事件不得触发回调');
});

test('dispatchGlobalChange：stop 后到达的值事件不再触发 global.watch 回调', async () => {
  const { text } = await runWithHost(`
    ctx.global.watch('home.k', (v) => ctx.log('info', 'CB:' + v));
    await ctx.keepAlive();
  `, { inject: { type: 'contextChange', scope: 'global', key: 'home.k', value: true, prev: false }, stopBefore: true, stopAt: 40, injectAt: 120 });
  assert.doesNotMatch(text, /CB:/, 'stopped 后 global 值事件不得触发回调');
});

test('dispatchWriterState：stop 后到达的写者状态不再触发 global.watch 回调', async () => {
  const { text } = await runWithHost(`
    ctx.global.watch('home.k', (v, prev, info) => ctx.log('info', 'CB:' + (info && info.type)));
    await ctx.keepAlive();
  `, { inject: { type: 'contextWriterState', scope: 'global', key: 'home.k', scriptId: 'writer', state: 'stopped', value: false }, stopBefore: true, stopAt: 40, injectAt: 120 });
  assert.doesNotMatch(text, /CB:/, 'stopped 后写者状态事件不得触发回调');
});

test('ctx.sleep：走 scheduleTimer——stop 清句柄后不再唤醒续体', async () => {
  const { text } = await runWithHost(`
    ctx.log('info', 'BEFORE');
    await ctx.sleep(300);
    ctx.log('info', 'AFTER_SLEEP');
  `, { stopBefore: true, stopAt: 40 });
  assert.match(text, /BEFORE/, 'stop 前日志正常');
  assert.doesNotMatch(text, /AFTER_SLEEP/, 'stop 后 sleep 不再 resolve 续体');
});

/* ---- executor 侧：stopInstance 标记后 callService 硬闸 ---- */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-stop-'));
const config = require('../server/config');
config.DATA = tmpRoot;
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');
const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };

function makeConnector(callLog) {
  return {
    demo: false,
    getState: () => ({ state: '23', attributes: {} }),
    listEntities: () => [],
    callService: async (domain, service, data) => { callLog.push({ domain, service, entity_id: data && data.entity_id }); return { ok: true }; },
  };
}

test('executor：正式实例停止后，在途 callService 不下发（connector 0 次）', async () => {
  /* 脚本跑一个较长 sleep，给测试时间发 stop；随后 wake 发起裸 callService。
   * 用 ctx.after 在 stop 后直接调 callService（绕开 ctx.write 的 runner 闸），
   * 验证 executor 侧 entry.stopped 硬闸。 */
  const script = `
    await ctx.sleep(60);
    await ctx.ha.callService('light', 'turn_on', { entity_id: 'light.afterstop' });
    ctx.log('info', 'DONE');
  `;
  const rec = store.submit('stopguard', { name: 'stopguard', script, flow: FLOW, channel: 'shadow' });
  store.publish('stopguard');
  const callLog = [];
  const connector = makeConnector(callLog);
  executor.start('stopguard', 1, connector);
  // 立刻停止：脚本还在 sleep(60) 阶段，stopInstance 会标记 entry.stopped
  executor.stop('stopguard', 'manual');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(callLog.length, 0, '实例已停止，callService 不得真实下发');
});
