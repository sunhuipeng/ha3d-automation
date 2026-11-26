'use strict';
/* 验证执行器层的影子硬隔离：
 * 即使脚本绕过自身 WRITE 隔离区、直接调用 ctx.ha.callService，
 * 影子模式下主进程（executor.handleRequest）也应拦截一切 HA 写调用，只读放行；
 * 发布/切正式后才真正下发到 connector.callService。全程用 mock connector，不碰真实 HA。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-exec-'));
const config = require('../server/config');
config.DATA = tmpRoot;
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
// 恶意脚本：不做任何影子判断，直接调用 HA 服务（绕过脚本内隔离）
const EVIL_SCRIPT = `
const r = await ctx.ha.getState('sensor.temp');
ctx.log('info', 'read=' + (r && r.state));
await ctx.ha.callService('light', 'turn_on', { entity_id: 'light.living' });
await ctx.ha.callService('water_heater', 'turn_off', { entity_id: 'water_heater.x' });
ctx.log('info', 'done');
`;

function makeConnector(callLog) {
  return {
    demo: false,
    getState: () => ({ state: '23', attributes: {} }),
    listEntities: () => [],
    callService: async (domain, service, data) => { callLog.push({ domain, service, entity_id: data && data.entity_id }); return { ok: true }; },
  };
}

function waitDone(sid, timeoutMs = 4000) {
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

test('影子模式：所有 HA 服务调用被主进程拦截，connector.callService 0 次；读操作放行', async () => {
  const rec = store.submit('evil', { name: 'evil', script: EVIL_SCRIPT, flow: FLOW, channel: 'shadow' });
  assert.equal(store.channelOf(rec.meta), 'shadow');
  const callLog = [];
  const connector = makeConnector(callLog);
  executor.start('evil', rec.version, connector);
  await waitDone('evil');
  assert.equal(callLog.length, 0, '影子模式下不应有任何真实 HA 写调用');
});

test('发布为正式后：同样的脚本真实下发（callService 2 次）', async () => {
  store.publish('evil'); // v1 → production
  assert.equal(store.getMeta('evil', 1).channel, 'production');
  const callLog = [];
  const connector = makeConnector(callLog);
  executor.start('evil', 1, connector);
  await waitDone('evil');
  assert.equal(callLog.length, 2, '正式模式应真实下发两次 callService');
  assert.deepEqual(callLog.map((c) => c.service), ['turn_on', 'turn_off']);
});
