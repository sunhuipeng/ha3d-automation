'use strict';
/* 端到端上下文测试：脚本通过真实 runner 的 ctx.global / ctx.local 写入，
 * 经 IPC 回到执行器落盘；影子脚本写进 shadow 命名空间，发布后写进 production，
 * 两者互不可见。用 mock connector，不碰真实 HA。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-ctx-e2e-'));
const config = require('../server/config');
config.DATA = tmpRoot; // 必须在 require context / store 之前覆盖
const context = require('../server/scripts/context');
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
const SCRIPT = `
await ctx.global.set('waterHeater.pendingStart', true);
await ctx.local.set('schedule.lastHelperTs', 73800);
ctx.log('info', 'ctx-done');
`;

const connector = {
  demo: false,
  getState: () => ({ state: 'off', attributes: {} }),
  listEntities: () => [],
  callService: async () => ({ ok: true }),
};

function waitDone(sid, timeoutMs = 5000) {
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

test('影子脚本经真实 runner 写上下文，落在 shadow 命名空间', async () => {
  const rec = store.submit('ctxe2e', { name: 'ctxe2e', script: SCRIPT, flow: FLOW, channel: 'shadow' });
  assert.equal(store.channelOf(rec.meta), 'shadow');
  executor.start('ctxe2e', rec.version, connector);
  await waitDone('ctxe2e');

  assert.equal(context.get('global', 'ctxe2e', 'waterHeater.pendingStart', true), true, '影子全局应写入');
  assert.equal(context.get('global', 'ctxe2e', 'waterHeater.pendingStart', false), undefined, '正式全局不应被影子污染');
  assert.equal(context.get('local', 'ctxe2e', 'schedule.lastHelperTs', true), 73800, '影子 local 应按脚本隔离');
  assert.equal(context.get('local', 'ctxe2e', 'schedule.lastHelperTs', false), undefined, '正式 local 不应有值');
});

test('发布为正式后写上下文，落在 production 命名空间', async () => {
  store.publish('ctxe2e'); // v1 → production
  executor.start('ctxe2e', 1, connector);
  await waitDone('ctxe2e');

  assert.equal(context.get('global', 'ctxe2e', 'waterHeater.pendingStart', false), true, '正式全局应写入');
  assert.equal(context.get('local', 'ctxe2e', 'schedule.lastHelperTs', false), 73800, '正式 local 应写入');
});

test('落盘文件包含 global 双命名空间与 local 分脚本桶', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'context.json'), 'utf8'));
  assert.ok(raw.global.shadow && raw.global.production, 'global 应有 shadow + production 两个命名空间');
  assert.ok(raw.local['ctxe2e:shadow'] && raw.local['ctxe2e:production'], 'local 应按 脚本:模式 分桶');
});
