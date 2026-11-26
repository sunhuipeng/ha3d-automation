'use strict';
/* 热池专项：懒创建 / 空闲超时销毁 / busy 不误杀 / 并发上限降级 / executor 端到端会话。
 * env 必须在本文件首次 require hot-pool 前设置（模块加载时读环境变量）。 */
process.env.HA3D_HOT_POOL_SIZE = '1';
process.env.HA3D_HOT_MAX_SESSIONS = '2';
process.env.HA3D_HOT_IDLE_MS = '400'; // 回收窗口 400ms，扫描间隔 = clamp(100,100..30000) = 100ms

import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-hotpool-'));
const config = require('../server/config');
config.DATA = tmpRoot; // 必须在 require context/store 之前覆盖

const hotPool = require('../server/scripts/hot-pool');
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
const connector = {
  demo: false,
  getState: () => ({ state: 'off', attributes: {} }),
  listEntities: () => [],
  callService: async () => ({ ok: true }),
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function waitUntil(pred, label, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let v = false;
      try { v = pred(); } catch (e) {}
      if (v) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return reject(new Error('等待超时：' + label));
      setTimeout(tick, 20);
    };
    tick();
  });
}
function waitDone(sid, timeoutMs = 8000) {
  return waitUntil(() => !executor.isRunning(sid), sid + ' 结束', timeoutMs);
}
function logText(sid, version) {
  return store.readLogs(sid, version).map((x) => String(x.message || '')).join('\n');
}

test('env 配置读取：pool/max/idle 三值生效', () => {
  assert.equal(hotPool.POOL_SIZE, 1);
  assert.equal(hotPool.MAX_SESSIONS, 2);
  assert.equal(hotPool.IDLE_MS, 400);
  assert.equal(hotPool.stats().workers, 0, '懒创建：启动阶段不应有任何 worker');
  assert.equal(hotPool.stats().sessions, 0);
});

test('懒创建：首次触发才 spawn，kill 后槽位释放', async () => {
  const s1 = hotPool.acquireSession({});
  assert.ok(s1, '有槽位应返回句柄');
  assert.equal(hotPool.stats().workers, 1, '首次触发才创建 worker');
  assert.equal(hotPool.stats().sessions, 1);
  s1.kill();
  assert.equal(hotPool.stats().sessions, 0, 'kill 后会话出表');
  assert.equal(hotPool.stats().workers, 1, 'worker 保留（尚未超空闲窗口）');
  s1.kill(); // 幂等
  assert.equal(hotPool.stats().sessions, 0);
});

test('并发上限：满则降级返回 null，释放后可再取', () => {
  const a = hotPool.acquireSession({});
  const b = hotPool.acquireSession({});
  assert.ok(a && b);
  assert.equal(hotPool.stats().workers, 1, '两个会话应复用同一 worker（poolSize=1）');
  assert.equal(hotPool.stats().sessions, 2);
  assert.equal(hotPool.acquireSession({}), null, '达 maxSessions=2 后应返回 null（executor 降级为新建 worker）');
  a.kill();
  const c = hotPool.acquireSession({});
  assert.ok(c, '释放一个槽位后可再取');
  assert.equal(hotPool.stats().workers, 1);
  b.kill();
  c.kill(); // 全部释放，让后续用例的空闲窗口从零会话起算
  assert.equal(hotPool.stats().sessions, 0);
});

test('空闲超时销毁：busy 不误杀，空闲超窗后销毁且下次懒重建', async () => {
  const s = hotPool.acquireSession({});
  await sleep(500); // 超过 IDLE_MS=400，但有会话在跑
  assert.equal(hotPool.stats().workers, 1, 'busy worker 不得被回收');
  s.kill();
  await waitUntil(() => hotPool.stats().workers === 0, '空闲 worker 被销毁', 2000);
  assert.equal(hotPool.stats().sessions, 0);
  const s2 = hotPool.acquireSession({}); // 懒重建
  assert.ok(s2, '销毁后下次触发应懒重建');
  assert.equal(hotPool.stats().workers, 1);
  s2.kill();
});

test('executor 端到端：正式一次性脚本跑在热池会话里，done 后槽位释放', async () => {
  const rec = store.submit('hotrun1', {
    name: '热池端到端', script: `ctx.log('info', 'HOT_OK');`, flow: FLOW, kind: 'script', channel: 'production',
  });
  executor.start('hotrun1', rec.version, connector);
  await waitDone('hotrun1');
  const logs = logText('hotrun1', rec.version);
  assert.match(logs, /runner 启动 v1｜模式=正式/, '会话消息经热 worker 路由回主进程');
  assert.match(logs, /HOT_OK/);
  assert.match(logs, /完成/);
  await waitUntil(() => hotPool.stats().sessions === 0, 'done 后热池槽位释放', 2000);
  assert.equal(hotPool.stats().workers >= 1, true, 'worker 保留待复用或待回收');
  await waitUntil(() => hotPool.stats().workers === 0, '测试尾部空闲回收', 2000);
});

test('stop/timeout 路径：kill 兜底同样释放槽位', async () => {
  const rec = store.submit('hotslow1', {
    name: '热池慢脚本', script: `await ctx.sleep(5000); ctx.log('info','NEVER');`, flow: FLOW, kind: 'script', channel: 'production',
  });
  executor.start('hotslow1', rec.version, connector);
  await waitUntil(() => executor.isRunning('hotslow1'), '实例登记');
  executor.stop('hotslow1', 'test');
  await waitDone('hotslow1');
  await waitUntil(() => hotPool.stats().sessions === 0, '停止后槽位释放', 2000);
  assert.ok(!logText('hotslow1', rec.version).includes('NEVER'), '协作停止后脚本不应跑到结尾');
});
