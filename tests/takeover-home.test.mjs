'use strict';
/* 接管方案步骤 6：给 Home 编辑页的动作与场景候选接口（GET /api/actions）。
 * 独立临时 DATA + 本地 HTTP 服务，不碰真实 HA。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-home-act-'));
const config = require('../server/config');
config.DATA = tmpRoot;
const express = require('express');
const store = require('../server/scripts/store');
const scriptRoutes = require('../server/routes/scripts');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
const ICON = '<svg viewBox="0 0 64 64" stroke="currentColor" fill="none"><path d="M8 8h48v48H8z"/></svg>';
let server = null;
let base = '';

test.before(async () => {
  store.submit('homeact1', {
    name: '测试场景', script: `ctx.log('info','x');`, flow: FLOW,
    kind: 'scene', channel: 'production', description: '两层客厅', icon: ICON,
  });
  store.submit('homeact2', {
    name: '影子动作', script: `ctx.log('info','y');`, flow: FLOW,
    kind: 'script',
  });
  store.submit('homelive1', {
    name: '常驻自动化', script: `await ctx.keepAlive();`, flow: FLOW,
    kind: 'automation', channel: 'production',
  });
  const app = express();
  app.use(express.json());
  app.use(scriptRoutes());
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('GET /api/actions：只返回短脚本/场景，带 id/kind/版本与可触发标记', async () => {
  const res = await fetch(base + '/actions'); // 路由挂在 /api 下，本测试直接挂根
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.items));
  assert.equal(data.items.length, 2, '常驻自动化不应出现在动作与场景列表');
  const ids = data.items.map((x) => x.id).sort();
  assert.deepEqual(ids, ['homeact1', 'homeact2']);
  const prod = data.items.find((x) => x.id === 'homeact1');
  assert.equal(prod.name, '测试场景');
  assert.equal(prod.kind, 'scene');
  assert.equal(prod.description, '两层客厅');
  assert.equal(prod.productionVersion, 1);
  assert.equal(prod.triggerable, true);
  assert.equal(prod.icon, ICON);
  assert.equal(prod.svg, ICON, 'Home 侧用 svg 字段存 SVG 源码，列表需同源返回');
  const shadow = data.items.find((x) => x.id === 'homeact2');
  assert.equal(shadow.productionVersion, null);
  assert.equal(shadow.triggerable, false, '影子版本不可被面板触发');
  assert.ok(!('script' in prod), '候选列表不应泄漏脚本正文');
});
