'use strict';
/* HTTP 端点 smoke：POST /api/script/:id/verify-mode + GET logs?source=sim。
 * 前端切换按钮只走这两个端点，必须验证「路由挂载 → executor → 状态/日志源」整条链，
 * 而不是只测 MCP（前端根本不经过 MCP）。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
process.env.HA3D_DEV_MODE = 'true';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-routes-sim-'));
const config = require('../server/config');
config.DATA = tmpRoot;
const express = require('express');
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');
const scriptRoutes = require('../server/routes/scripts');

const FLOW = { version: 1, nodes: [], edges: [] };
const SCRIPT = `
  ctx.actions({ flag: async () => {} });
  ctx.watch('sensor.power', async () => {});
  ctx.log('info', 'route-test-ready');
  await ctx.keepAlive();
`;

let server = null;
let base = '';
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', scriptRoutes());
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });

async function post(pathname, body) {
  const r = await fetch(base + pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
}
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('verify-mode 端点：无影子版本时 400 并透出原因', async () => {
  const r = await post('/api/script/no-such-script/verify-mode', { mode: 'simulate' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /没有影子版本/);
});

test('verify-mode 端点：切 simulate 返回 verifyMode，日志源可读 sim 文件', async () => {
  const sid = 'routes-sim';
  const rec = store.submit(sid, { name: '路由仿真', script: SCRIPT, flow: FLOW, channel: 'shadow', kind: 'automation' });

  const sw = await post(`/api/script/${sid}/verify-mode`, { mode: 'simulate', startAt: '2026-11-26T20:29:55+08:00' });
  assert.equal(sw.status, 200);
  assert.equal(sw.body.ok, true);
  assert.equal(sw.body.verifyMode, 'simulate');

  /* 实例列表带 verifyMode：前端徽章数据源 */
  const detail = await fetch(`${base}/api/script/${sid}`).then((r) => r.json());
  const row = (detail.runningVersions || []).find((x) => x.version === rec.version);
  assert.ok(row, '详情应返回影子实例');
  assert.equal(row.verifyMode, 'simulate');

  /* 等仿真日志落盘后读 source=sim */
  let logs = [];
  for (let i = 0; i < 30; i += 1) {
    const r = await fetch(`${base}/api/script/${sid}/logs?version=${rec.version}&source=sim`).then((x) => x.json());
    assert.equal(r.source, 'sim');
    logs = r.logs || [];
    if (logs.some((l) => /route-test-ready/.test(l.message))) break;
    await sleep(50);
  }
  assert.ok(logs.some((l) => /route-test-ready/.test(l.message)), 'source=sim 应读到仿真日志');

  /* 真实日志不被仿真写入 */
  const real = await fetch(`${base}/api/script/${sid}/logs?version=${rec.version}`).then((r) => r.json());
  assert.equal(real.source, 'real');
  assert.ok(!(real.logs || []).some((l) => /route-test-ready/.test(l.message)), '真实日志不应包含仿真日志');

  const back = await post(`/api/script/${sid}/verify-mode`, { mode: 'follow' });
  assert.equal(back.status, 200);
  assert.equal(back.body.verifyMode, 'follow');
  const detail2 = await fetch(`${base}/api/script/${sid}`).then((r) => r.json());
  const row2 = (detail2.runningVersions || []).find((x) => x.version === rec.version);
  assert.equal(row2 && row2.verifyMode, 'follow');

  /* simClose 只对 simulate 生效：follow 下必须拒绝，避免把实跑验证误停 */
  await assert.rejects(() => executor.simClose(sid), /follow/);

  const again = await post(`/api/script/${sid}/verify-mode`, { mode: 'simulate' });
  assert.equal(again.status, 200);
  const closed = await executor.simClose(sid);
  assert.equal(closed.closed, true);
  const detail3 = await fetch(`${base}/api/script/${sid}`).then((r) => r.json());
  assert.equal((detail3.runningVersions || []).length, 0, 'simClose 后不应残留实例');
});
