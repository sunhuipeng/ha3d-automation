'use strict';
/* 审计第 4 类（bug）回归测试：
 * 4.11 simulate 实例不持久化运行意图（重启后不得按 follow 悄悄真跑）；
 * 4.5 ENV_OVERRIDES 表导出完整（config.js 对外契约）。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-audit4-'));
const config = require('../server/config');
config.DATA = tmpRoot;
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');
const runState = require('../server/scripts/run-state');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeConnector() {
  return { ready: true, demo: false, isReady() { return this.ready; }, getState() { return null; }, listEntities() { return []; }, callService: async () => ({ ok: true }) };
}

test('ENV_OVERRIDES：可写字段全部有对应环境变量映射（4.5 overridden 警告依据）', () => {
  const { WRITABLE_KEYS } = (() => {
    // WRITABLE_KEYS 未导出：从 saveConfig 白名单行为反推——直接断言已知七个字段
    return { WRITABLE_KEYS: ['haUrl', 'token', 'runnerTimeoutMs', 'actionCooldownMs', 'maxRestarts', 'allowMcpCallService', 'executionMode'] };
  })();
  for (const key of WRITABLE_KEYS) {
    assert.ok(config.ENV_OVERRIDES[key], `ENV_OVERRIDES 缺少 ${key}`);
    assert.equal(typeof config.ENV_OVERRIDES[key], 'string');
  }
});

test('simulate 实例不写运行意图；切回 follow 后恢复（4.11）', async (t) => {
  t.after(() => { try { executor.stopAll(); } catch (e) {} });
  const conn = makeConnector();
  store.submit('audit4intent', {
    name: 'audit4intent', script: 'ctx.log("info","boot"); await new Promise(()=>{});', flow: FLOW, kind: 'automation', channel: 'shadow',
  });
  assert.equal(runState.has('audit4intent', 1), false, '提交不产生运行意图');

  await executor.switchVerifyMode('audit4intent', 'simulate', { startAt: '2026-11-28T03:00:00.000Z', seed: {} });
  await wait(150);
  assert.equal(runState.has('audit4intent', 1), false,
    'simulate 实例不得持久化运行意图——否则进程重启后 restore 会把它按 follow 悄悄拉起真跑');

  await executor.switchVerifyMode('audit4intent', 'follow');
  await wait(150);
  assert.equal(runState.has('audit4intent', 1), true, '切回 follow（真实验证态）后运行意图恢复');
});
