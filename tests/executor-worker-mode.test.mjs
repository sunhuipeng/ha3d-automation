'use strict';
/* executor 集成测试：EXECUTION_MODE=worker 时 start() 应选中 worker 宿主，
 * 短脚本经 worker 完整走通 run → request → done → cleanup 生命周期；
 * stop() 也能停掉 worker 实例（terminate + 状态归位）。全程 mock connector。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.EXECUTION_MODE = 'worker'; // 必须在 require config 前设置（getConfig 首次调用即缓存）

const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-exec-worker-'));
const config = require('../server/config');
config.DATA = tmpRoot;
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');

assert.equal(config.getConfig().executionMode, 'worker');

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
      if (!executor.isRunning(sid)) return resolve(Date.now() - t0);
      if (Date.now() - t0 > timeoutMs) return reject(new Error('等待脚本结束超时'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

test('worker 模式：短脚本完整走通生命周期并正确落日志', async () => {
  const rec = store.submit('wkr-short', {
    name: 'worker 短脚本', script: `
      const s = await ctx.ha.entity('sensor.temp');
      ctx.log('info', 'read=' + (s && s.state));
      const w = await ctx.local.set('run.count', 1);
      ctx.log('info', 'LOCAL:' + JSON.stringify(await ctx.local.get('run.count')));
    `, flow: FLOW, channel: 'production',
  });
  const callLog = [];
  executor.start('wkr-short', rec.version, makeConnector(callLog));
  assert.ok(executor.isRunning('wkr-short'));
  await waitDone('wkr-short');
  assert.equal(callLog.length, 0, '影子模式不得真实下发');
  const logs = store.readLogs('wkr-short', rec.version, 50).map((l) => l.message).join('\n');
  assert.match(logs, /read=23/);
  assert.match(logs, /LOCAL:1/, '上下文经 postMessage IPC 读写应正常');
});

test('worker 模式：stop() 能停掉 worker 长驻实例', async () => {
  const rec = store.submit('wkr-long', {
    name: 'worker 长驻脚本', kind: 'automation', script: `
      for (;;) { await ctx.sleep(100); ctx.log('info', 'tick'); }
    `, flow: FLOW, channel: 'production',
  });
  executor.start('wkr-long', rec.version, makeConnector([]));
  assert.ok(executor.isRunning('wkr-long'));
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(executor.stop('wkr-long'));
  await waitDone('wkr-long');
  assert.equal(executor.isRunning('wkr-long'), false, 'stop 后实例应被清理');
});
