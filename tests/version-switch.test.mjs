'use strict';
/* 版本切换语义测试（影子可原地修改 + 跨版本发布不停旧实例的漏洞修复）：
 * 1) 影子覆盖：版本号不变、revision 递增、运行中的影子被改前先停；
 * 2) publish 跨版本：自动停旧→以影子启动新→发布热切，运行版本必须等于新正式版；
 * 3) publish 严格模式 autoSwitch:false：直接报错，不动状态；
 * 4) publish 目标版本起不来：回退旧版本继续跑，不留"归档版本还在真实下发"。
 * 全程用隔离 tmp 数据 + mock connector，不连真实 HA。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-switch-'));
const config = require('../server/config');
config.DATA = tmpRoot;
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitRunning(id, want, timeoutMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (executor.isRunning(id) === want) return true;
    await wait(30);
  }
  return executor.isRunning(id) === want;
}
const LIVE = (tag) => `
ctx.log('info', '${tag} dryRun=' + ctx.dryRun);
await new Promise(() => {});
`;
function makeConnector() {
  return {
    ready: true, demo: false,
    isReady() { return this.ready; },
    getState() { return null; },
    listEntities() { return []; },
    callService: async () => ({ ok: true }),
  };
}

test('影子可原地修改：覆盖运行中的影子会先停止，版本号不变、revision+1', async (t) => {
  t.after(() => { try { executor.stopAll(); } catch (e) { /* 清理 */ } });
  const conn = makeConnector();
  const r1 = store.submit('sw3', { name: 'sw3', script: LIVE('v1'), flow: FLOW, kind: 'automation', channel: 'shadow' });
  executor.start('sw3', r1.version, conn);
  assert.equal(await waitRunning('sw3', true), true);

  const r2 = executor.submitScript('sw3', { name: 'sw3', script: LIVE('v2'), flow: FLOW, kind: 'automation', channel: 'shadow' });
  assert.equal(r2.version, 1, '覆盖不新增版本号');
  assert.equal(r2.meta.revision, 2);
  assert.equal(executor.isRunning('sw3'), false, '改运行中的影子应先停，避免旧代码继续跑');
  assert.equal(executor.versionRuntimeStatus('sw3', 1), 'stopped', '停止后运行状态归位（executor 内存）');
  assert.deepEqual(store.listVersions('sw3'), [1]);
});

test('publish 跨版本：自动切换实例，归档版本不会继续真实下发', async (t) => {
  t.after(() => { try { executor.stopAll(); } catch (e) { /* 清理 */ } });
  const conn = makeConnector();
  const r1 = store.submit('sw1', { name: 'sw1', script: LIVE('v1'), flow: FLOW, kind: 'automation', channel: 'shadow' });
  executor.publish('sw1', r1.version);       // v1 正式
  executor.start('sw1', r1.version, conn);
  assert.equal(await waitRunning('sw1', true), true);

  const r2 = store.submit('sw1', { name: 'sw1', script: LIVE('v2'), flow: FLOW, kind: 'automation', channel: 'shadow' });
  assert.equal(r2.version, 2, '正式版存在时提交分配新版本号');

  const res = executor.publish('sw1', 2);
  assert.equal(res.version, 2);
  assert.equal(res.switchedFrom, 1, '应报告从 v1 切换');
  assert.equal(executor.runningVersion('sw1'), 2, '实例必须切到新正式版');
  assert.equal(store.getMeta('sw1', 1).channel, 'archive');
  assert.equal(store.getMeta('sw1', 2).channel, 'production');
  assert.equal(executor.versionRuntimeStatus('sw1', 1), 'stopped', '旧版本运行状态不能残留 running');

  /* 关键回归：旧实例在 500ms 宽限期后才真正退出，退出回调不能把新实例的登记抹掉
   * （否则新进程变孤儿：还在跑但停不下来、runningVersion 变 null） */
  await wait(900);
  assert.equal(executor.runningVersion('sw1'), 2, '旧实例退出后新实例仍须被登记在册');
  assert.equal(executor.versionRuntimeStatus('sw1', 2), 'running', '新实例运行状态不能丢失');

  const logs = store.readLogs('sw1', 2, 50).map((l) => l.message).join('\n');
  /* 影子已统一为专属 worker（2026-11-26）：正式目标默认 fork → 跨宿主重建而非 mode 热切 */
  assert.match(logs, /已发布为正式版本：释放影子/, 'publish 时影子实例按目标宿主重建正式通道');
  assert.match(logs, /模式=正式/, '重建的正式实例以正式模式启动（真实下发）');

  executor.stop('sw1', 'manual');
  assert.equal(await waitRunning('sw1', false), true, '新实例必须仍可被停止');
});

test('publish 严格模式：运行版本与目标不一致时直接报错，不改变任何状态', async (t) => {
  t.after(() => { try { executor.stopAll(); } catch (e) { /* 清理 */ } });
  const conn = makeConnector();
  const r1 = store.submit('sw2', { name: 'sw2', script: LIVE('v1'), flow: FLOW, kind: 'automation', channel: 'shadow' });
  executor.publish('sw2', r1.version);
  executor.start('sw2', r1.version, conn);
  assert.equal(await waitRunning('sw2', true), true);

  store.submit('sw2', { name: 'sw2', script: LIVE('v2'), flow: FLOW, kind: 'automation', channel: 'shadow' });
  assert.throws(() => executor.publish('sw2', 2, { autoSwitch: false }), /请先停止再发布/);
  assert.equal(executor.runningVersion('sw2'), 1, '严格模式下旧实例保持不动');
  assert.equal(store.getMeta('sw2', 1).channel, 'production');
  assert.equal(store.getMeta('sw2', 2).channel, 'shadow', '目标版本仍是影子，未被发布');

  executor.stop('sw2', 'manual');
  await waitRunning('sw2', false);
});

test('publish 目标版本起不来：回退旧版本继续运行（不留半吊子状态）', async (t) => {
  t.after(() => { try { executor.stopAll(); } catch (e) { /* 清理 */ } });
  const conn = makeConnector();
  const r1 = store.submit('sw4', { name: 'sw4', script: LIVE('v1'), flow: FLOW, kind: 'automation', channel: 'shadow' });
  executor.publish('sw4', r1.version);
  executor.start('sw4', r1.version, conn);
  assert.equal(await waitRunning('sw4', true), true);

  assert.throws(() => executor.publish('sw4', 99), /启动失败.*回退到 v1|版本不存在/);
  assert.equal(executor.runningVersion('sw4'), 1, '应回退到旧版本继续跑');
  assert.equal(store.getMeta('sw4', 1).channel, 'production', '旧版本仍是正式版');

  executor.stop('sw4', 'manual');
  await waitRunning('sw4', false);
});

test('并行：正式与影子实例可同时运行（互不影响）；双正式被拒绝；发布后只剩一个正式实例', async (t) => {
  t.after(() => { try { executor.stopAll(); } catch (e) { /* 清理 */ } });
  const conn = makeConnector();
  const r1 = store.submit('sw5', { name: 'sw5', script: LIVE('v1'), flow: FLOW, kind: 'automation', channel: 'shadow' });
  executor.publish('sw5', r1.version);          // v1 正式
  executor.start('sw5', r1.version, conn);
  assert.equal(await waitRunning('sw5', true), true);

  const r2 = store.submit('sw5', { name: 'sw5', script: LIVE('v2'), flow: FLOW, kind: 'automation', channel: 'shadow' }); // v2 影子
  executor.start('sw5', r2.version, conn);       // 影子实例与正式实例并行
  assert.equal(await waitRunning('sw5', true), true);
  assert.deepEqual(
    executor.runningVersions('sw5').map((x) => [x.version, x.mode]),
    [[1, 'production'], [2, 'shadow']],
    '正式 + 影子各一个实例',
  );

  const r3 = store.submit('sw5', { name: 'sw5', script: LIVE('v3'), flow: FLOW, kind: 'automation', channel: 'production' }); // v3 正式
  assert.throws(() => executor.start('sw5', r3.version, conn), /正式版本 v1 正在运行/, '第二个正式实例必须被拒绝');

  /* 发布正在运行的影子 v2：影子实例原地转正式，旧正式实例被停 → 只剩一个正式实例 */
  const res = executor.publish('sw5', 2);
  assert.equal(res.switchedFrom, 1);
  await wait(900); // 越过旧实例退出宽限期
  assert.equal(executor.runningVersions('sw5').length, 1, '发布后只剩一个实例');
  const only = executor.runningVersions('sw5')[0];
  assert.equal(only.version, 2);
  assert.equal(only.mode, 'production');
  assert.equal(executor.versionRuntimeStatus('sw5', 2), 'running');

  executor.stop('sw5', 'manual');
  assert.equal(await waitRunning('sw5', false), true);
});
