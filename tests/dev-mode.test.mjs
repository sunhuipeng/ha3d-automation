'use strict';
/* 开发模式（HA3D_DEV_MODE=true）集成测试：
 * ① DEV_MODE 仅由环境变量决定；
 * ② 正式版本启动保持正式身份（dryRun=false），但设备写被 devMode 闸拦截（只记日志不下发）；
 * ③ 正式版本自动恢复、不再跳过；
 * ④ 影子版本可在开发模式发布；
 * ⑤ 上下文写仍按通道隔离：正式写正式桶、影子写影子桶，读统一读正式桶；
 * 全程 mock connector。MCP 直调不受 devMode 约束（tools.js 无该分支），见独立断言。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.HA3D_DEV_MODE = 'true'; // 必须在 require config 前设置

const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-devmode-'));
const config = require('../server/config');
config.DATA = tmpRoot;
const store = require('../server/scripts/store');
const runState = require('../server/scripts/run-state');
const executor = require('../server/scripts/executor');
const context = require('../server/scripts/context');

assert.equal(config.DEV_MODE, true);
assert.equal(config.getConfig().devMode, true);

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };

function makeConnector(callLog) {
  return {
    demo: false,
    getState: () => ({ state: '23', attributes: {} }),
    listEntities: () => [],
    callService: async (domain, service, data) => { callLog.push({ domain, service }); return { ok: true }; },
  };
}

function waitDone(sid, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (!executor.isRunning(sid)) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('等待脚本结束超时'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function waitLog(sid, version, pattern, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const text = store.readLogs(sid, version, 200).map((l) => l.message).join('\n');
      if (pattern.test(text)) return resolve(text);
      if (Date.now() - t0 > timeoutMs) return reject(new Error('等待日志超时：' + pattern));
      setTimeout(tick, 50);
    };
    tick();
  });
}

test('开发模式：正式版本保持正式身份，但设备写被拦截只记日志', async () => {
  const rec = store.submit('devmode1', {
    name: '开发模式正式脚本', script: `
      await ctx.ha.callService('switch', 'turn_on', { entity_id: 'switch.x' });
      ctx.log('info', 'after-write');
    `, flow: FLOW, channel: 'production',
  });
  const callLog = [];
  const entry = executor.start('devmode1', rec.version, makeConnector(callLog));
  assert.equal(entry.dryRun, false, '正式通道实例必须保持正式身份（不再强制影子口径）');
  await waitDone('devmode1');
  assert.equal(callLog.length, 0, 'HA 写调用不得真实下发');
  const logs = store.readLogs('devmode1', rec.version, 50).map((l) => l.message).join('\n');
  assert.match(logs, /开发模式/, '拦截日志须标注开发模式');
  assert.match(logs, /after-write/, '脚本本体照常执行（读正常）');
});

test('开发模式：正式版本自动恢复，身份为正式', () => {
  const rec = store.submit('devmode2', {
    name: '恢复验证', kind: 'automation', script: `await ctx.keepAlive();`,
    flow: FLOW, channel: 'production',
  });
  runState.mark('devmode2', rec.version, Date.now());
  const result = executor.restore(makeConnector([]));
  const restored = result.restored.find((s) => s.id === 'devmode2');
  assert.ok(restored, '正式实例应被恢复（不再跳过）');
  assert.equal(restored.mode, 'production', '恢复后身份应为正式');
  assert.equal(executor.isRunning('devmode2'), true);
  assert.ok(runState.read()['devmode2#v' + rec.version], '清单条目保留');
  executor.stop('devmode2', 'test');
  runState.clear('devmode2', rec.version);
});

test('开发模式：影子版本可发布为正式版本', () => {
  const rec = store.submit('devmode3', { name: '发布验证', script: `ctx.log('info', 'x');`, flow: FLOW, channel: 'shadow' });
  const result = executor.publish('devmode3', rec.version);
  assert.equal(result.version, rec.version);
  assert.equal(store.channelOf(store.get('devmode3', rec.version).meta), 'production');
});

test('开发模式：正式脚本写正式上下文桶，影子读者读到正式桶', async () => {
  const writer = store.submit('devmode4w', {
    name: '正式写者', script: `await ctx.global.set('sig.dev', { n: 42 });`,
    flow: FLOW, channel: 'production',
  });
  executor.start('devmode4w', writer.version, makeConnector([]));
  await waitDone('devmode4w');
  const prodVal = context.get('global', 'devmode4w', 'sig.dev', false, null);
  assert.deepEqual(prodVal, { n: 42 }, '正式实例写入应落正式桶');

  const reader = store.submit('devmode4r', {
    name: '影子读者', script: `
      const v = await ctx.global.get('sig.dev', null);
      ctx.log('info', 'READ:' + JSON.stringify(v));
    `, flow: FLOW, channel: 'shadow',
  });
  executor.start('devmode4r', reader.version, makeConnector([]));
  const logs = await waitLog('devmode4r', reader.version, /READ:/);
  assert.match(logs, /"n":42/, '影子读者应读到正式桶的值（读不隔离）');
});

test('开发模式：脚本 ctx.write（动作闸）在开发模式也只记日志', async () => {
  const rec = store.submit('devmode5', {
    name: '动作闸验证', script: `
      ctx.actions({ flip: async () => { throw new Error('不应执行真实动作'); } });
      const ok = await ctx.write('flip', '测试动作', 'n1');
      ctx.log('info', 'WRITE_RESULT:' + ok);
    `, flow: FLOW, channel: 'production',
  });
  executor.start('devmode5', rec.version, makeConnector([]));
  const logs = await waitLog('devmode5', rec.version, /WRITE_RESULT:false/);
  assert.match(logs, /开发模式/, 'ctx.write 拦截日志须标注开发模式');
  await waitDone('devmode5');
});

test('开发模式：MCP 直调路径不含 devMode 拦截分支', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/mcp/tools.js'), 'utf8');
  const start = src.indexOf("'automation_call_service'");
  const block = src.slice(start, start + 1200);
  assert.ok(!/ctx\.devMode/.test(block), 'MCP call_service 不应检查 devMode');
});
