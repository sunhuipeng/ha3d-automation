import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { buildTools } = require('../server/mcp/tools.js');
const PKG_VERSION = require('../package.json').version;

/* 抓 automation_get_system_info 注册的 handler 并实调，验证返回体 */
function capture() {
  const handlers = {};
  const server = { tool: (name, _desc, _shape, cb) => { handlers[name] = cb; } };
  const connector = { status: 'connected', demo: false };
  const executor = { runningList: () => [{ id: 'a', version: 1 }] };
  buildTools(server, { connector, executor });
  return handlers;
}

async function callSystemInfo() {
  const handlers = capture();
  assert.ok(handlers['automation_get_system_info'], '工具未注册');
  const res = await handlers['automation_get_system_info']({});
  return { res, payload: JSON.parse(res.content[0].text) };
}

test('automation_get_system_info：version 与 package.json 一致', async () => {
  const { payload } = await callSystemInfo();
  assert.equal(payload.version, PKG_VERSION);
});

test('automation_get_system_info：返回全部必需运行态字段', async () => {
  const { payload } = await callSystemInfo();
  for (const key of ['version', 'devMode', 'executionMode', 'haStatus', 'demo', 'scripts', 'running', 'node', 'platform', 'uptimeSeconds', 'ts']) {
    assert.ok(Object.hasOwn(payload, key), '缺字段：' + key);
  }
  assert.equal(typeof payload.devMode, 'boolean');
  assert.equal(typeof payload.demo, 'boolean');
  assert.equal(payload.haStatus, 'connected');
  assert.equal(payload.running, 1);
  assert.match(payload.node, /^v\d+/);
  assert.ok(payload.uptimeSeconds >= 0);
});

test('automation_get_system_info：不泄露 token / HA URL 等敏感配置', async () => {
  const { res, payload } = await callSystemInfo();
  const raw = JSON.stringify(payload);
  for (const leak of ['token', 'haUrl', 'HA_URL', 'HA_TOKEN']) {
    assert.ok(!raw.includes(leak), '返回体含敏感字段：' + leak);
  }
  assert.equal(res.isError, undefined);
});
