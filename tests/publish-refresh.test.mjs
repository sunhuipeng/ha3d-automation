'use strict';
/* 发布后前端详情必须刷新：服务端 publish 的 refresh 广播需含 script + scriptId/version。
 * 回归点：曾只广播 scripts+versions，导致 MCP 发布后前端详情 meta.channel 卡在旧 shadow，
 * "进入仿真"按钮残留，用户切走再切回（open 重拉详情）才消失。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-pubrefresh-'));
const config = require('../server/config');
config.DATA = tmpRoot;
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');
const hub = require('../server/lib/ws-hub');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };

function capture(fn) {
  const orig = hub.broadcast;
  const seen = [];
  hub.broadcast = (payload) => { seen.push({ ...payload }); return 0; };
  try { fn(); } finally { hub.broadcast = orig; }
  return seen;
}

test('publish 广播含 script 且带 scriptId/version，前端可重拉详情更新 channel', () => {
  const r = store.submit('pubrefresh', {
    name: 'pubrefresh', script: 'ctx.log("info","x");', flow: FLOW, kind: 'scene', channel: 'shadow',
  });
  const seen = capture(() => executor.publish('pubrefresh', r.version));
  const refreshes = seen.filter((p) => p.type === 'refresh');
  assert.deepEqual(
    [...new Set(refreshes.map((p) => p.what))].sort(),
    ['script', 'scripts', 'versions'],
    '发布必须同时刷新列表、详情、版本条',
  );
  const detail = refreshes.find((p) => p.what === 'script');
  assert.equal(detail.scriptId, 'pubrefresh');
  assert.equal(detail.version, r.version, '带目标版本，前端 open 能切到刚发布的正式版');
  assert.equal(store.getMeta('pubrefresh', r.version).channel, 'production');
});
