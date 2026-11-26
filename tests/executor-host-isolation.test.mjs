'use strict';
/* 影子强制专属 worker（宿主隔离，2026-11-26 口径）：影子实例每次新建一个独立 worker 线程
 * （host=worker，跑完即毁；未验证代码失控只影响自己，terminate 可强杀异步续体），不必 fork
 * 独立进程——写隔离仍由主进程执行器硬拦截兜底；正式脚本按全局 EXECUTION_MODE（本文件设为
 * inprocess）。与 executor-worker-mode.test.mjs（正式走 worker）互补。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.EXECUTION_MODE = 'inprocess'; // 必须在 require config 前设置（getConfig 首次调用即缓存）

const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-host-iso-'));
const config = require('../server/config');
config.DATA = tmpRoot;
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
const connector = {
  demo: false,
  getState: () => ({ state: '1', attributes: {} }),
  listEntities: () => [],
  callService: async () => ({ ok: true }),
};

test('影子强制专属 worker：inprocess 全局下影子走独立线程，正式脚本才走主进程', async () => {
  const shadow = store.submit('host-shadow', {
    name: '影子宿主', kind: 'automation', script: `await ctx.keepAlive();`, flow: FLOW, channel: 'shadow',
  });
  executor.start('host-shadow', shadow.version, connector);
  const sv = executor.runningVersions('host-shadow').find((r) => r.mode === 'shadow');
  assert.equal(sv.host, 'worker', '影子必须独享全新 worker 线程（硬隔离）');

  const prod = store.submit('host-prod', {
    name: '正式宿主', kind: 'automation', script: `await ctx.keepAlive();`, flow: FLOW, channel: 'production',
  });
  executor.start('host-prod', prod.version, connector);
  const pv = executor.runningVersions('host-prod').find((r) => r.mode === 'production');
  assert.equal(pv.host, 'inprocess', '正式脚本按 EXECUTION_MODE 走主进程');

  executor.stop('host-shadow');
  executor.stop('host-prod');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(executor.isRunning('host-shadow'), false, 'stop 后影子实例应被清理');
  assert.equal(executor.isRunning('host-prod'), false, 'stop 后正式实例应被清理');
});

test('发布迁移：影子 worker 实例 publish 后重建为 inprocess 正式实例', async () => {
  const rec = store.submit('host-migrate', {
    name: '宿主迁移', kind: 'automation', script: `await ctx.keepAlive();`, flow: FLOW, channel: 'shadow',
  });
  executor.start('host-migrate', rec.version, connector);
  const before = executor.runningVersions('host-migrate').find((r) => r.mode === 'shadow');
  assert.equal(before.host, 'worker', '发布前：影子强制专属 worker');

  executor.publish('host-migrate', rec.version);

  const after = executor.runningVersions('host-migrate').find((r) => r.mode === 'production');
  assert.ok(after, '发布后正式实例应在运行');
  assert.equal(after.version, rec.version, '同一版本继续运行');
  assert.equal(after.host, 'inprocess', '发布后：影子 worker 已释放，正式实例按 EXECUTION_MODE 重建在主进程');

  executor.stop('host-migrate');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(executor.isRunning('host-migrate'), false, 'stop 后实例应被清理');
});

test('脚本级宿主覆盖：meta.hostMode=fork 的正式脚本在 inprocess 全局下独享子进程', async () => {
  const rec = store.submit('host-override', {
    name: '覆盖宿主', kind: 'automation', script: `await ctx.keepAlive();`, flow: FLOW,
    channel: 'production', hostMode: 'fork',
  });
  assert.equal(rec.meta.hostMode, 'fork', 'meta 应持久化 hostMode 覆盖');
  executor.start('host-override', rec.version, connector);
  const rv = executor.runningVersions('host-override').find((r) => r.mode === 'production');
  assert.equal(rv.host, 'fork', '脚本级覆盖优先于全局 EXECUTION_MODE');

  executor.stop('host-override');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(executor.isRunning('host-override'), false);
});

test('脚本级宿主覆盖：影子提交迭代自动继承 hostMode，非法值提交被拒', () => {
  /* 继承：host-override 上一版 hostMode=fork，影子覆盖（不传 hostMode）应继承 */
  const shadow = store.submit('host-override', {
    name: '覆盖宿主', kind: 'automation', script: `await ctx.keepAlive();`, flow: FLOW, channel: 'shadow',
  });
  assert.equal(shadow.meta.hostMode, 'fork', '影子覆盖迭代应从上一版继承 hostMode');

  assert.throws(
    () => store.submit('host-override', {
      name: '覆盖宿主', kind: 'automation', script: `await ctx.keepAlive();`, flow: FLOW,
      channel: 'shadow', hostMode: 'bogus',
    }),
    /hostMode 非法/,
    '非法 hostMode 必须 fail-fast'
  );
});

test('覆盖为 worker 的脚本：publish 影子后同宿主热切换（不迁移、实例连续运行）', async () => {
  /* 影子恒为专属 worker；meta.hostMode=worker → 正式目标也是 worker → publish 走热切换分支 */
  const rec = store.submit('host-hotfork', {
    name: 'worker 热切换', kind: 'automation', script: `await ctx.keepAlive();`, flow: FLOW,
    channel: 'shadow', hostMode: 'worker',
  });
  executor.start('host-hotfork', rec.version, connector);
  const before = executor.runningVersions('host-hotfork').find((r) => r.mode === 'shadow');
  assert.equal(before.host, 'worker');

  executor.publish('host-hotfork', rec.version);

  const after = executor.runningVersions('host-hotfork').find((r) => r.mode === 'production');
  assert.ok(after, '发布后正式实例应在运行');
  assert.equal(after.startedAt, before.startedAt, '热切换：实例未重建（startedAt 不变），零中断');
  assert.equal(after.host, 'worker', '覆盖为 worker 的脚本发布后宿主不变');

  executor.stop('host-hotfork');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(executor.isRunning('host-hotfork'), false);
});

test('覆盖为 fork 的脚本：publish 后影子(worker)→正式(fork) 跨宿主重建', async () => {
  /* 影子不继承 hostMode=fork 的宿主形态（恒 worker）；发布后目标 fork ≠ 影子 worker → 重建 */
  const rec = store.submit('host-forkmigrate', {
    name: 'fork 跨宿主迁移', kind: 'automation', script: `await ctx.keepAlive();`, flow: FLOW,
    channel: 'shadow', hostMode: 'fork',
  });
  executor.start('host-forkmigrate', rec.version, connector);
  const before = executor.runningVersions('host-forkmigrate').find((r) => r.mode === 'shadow');
  assert.equal(before.host, 'worker', '影子宿主恒为 worker（不受 meta.hostMode=fork 影响）');

  executor.publish('host-forkmigrate', rec.version);

  const after = executor.runningVersions('host-forkmigrate').find((r) => r.mode === 'production');
  assert.ok(after, '发布后正式实例应在运行');
  assert.notEqual(after.startedAt, before.startedAt, '跨宿主迁移：实例重建（startedAt 变化）');
  assert.equal(after.host, 'fork', '正式实例按脚本覆盖的 fork 宿主重建');

  executor.stop('host-forkmigrate');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(executor.isRunning('host-forkmigrate'), false);
});
