'use strict';
/* 运行状态 + 版本的持久化恢复测试：
 * 运行意图清单 mark/clear、start 落盘、手动停止清除、服务关闭保留、
 * restore 按版本恢复 + 脏条目跳过。用隔离 tmp 数据 + mock connector，不碰真实 HA。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-restore-'));
const config = require('../server/config');
config.DATA = tmpRoot;
const store = require('../server/scripts/store');
const runState = require('../server/scripts/run-state');
const executor = require('../server/scripts/executor');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
/* 长驻脚本：保持事件循环，供 start/stop/restore 观察运行状态 */
const IDLE = `setInterval(() => {}, 1000);`;
const connector = { demo: true, getState: () => null, listEntities: () => [], callService: async () => ({}) };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitRunning(id, want = true, timeoutMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (executor.isRunning(id) === want) return true;
    await wait(30);
  }
  return executor.isRunning(id) === want;
}

test('run-state：mark / read / has / clear 基本语义（按 脚本+版本 登记）', () => {
  assert.deepEqual(runState.read(), {});
  runState.mark('a', 3, 12345);
  assert.equal(runState.has('a'), true);
  assert.deepEqual(runState.read()['a#v3'], { scriptId: 'a', version: 3, startedAt: 12345 });
  runState.mark('a', 4); // 另一个版本：新条目（正式/影子可并存）
  assert.equal(runState.read()['a#v4'].version, 4);
  runState.clear('a', 3); // 只清指定版本
  assert.equal(runState.has('a', 3), false);
  assert.equal(runState.has('a', 4), true);
  runState.clear('a');    // 不带版本清该脚本全部
  assert.equal(runState.has('a'), false);
  runState.clear('none'); // 不存在不报错
});

test('run-state：拒绝非法 id / 版本，不污染清单', () => {
  runState.mark('../evil', 1);
  runState.mark('bad', 0);
  runState.mark('bad2', 1.5);
  assert.deepEqual(runState.read(), {});
});

test('start 落盘运行意图；手动 stop 清除', async () => {
  const rec = store.submit('r1', { name: 'r1', script: IDLE, flow: FLOW, kind: 'automation', channel: 'shadow' });
  executor.start('r1', rec.version, connector);
  assert.equal(await waitRunning('r1', true), true);
  assert.equal(runState.read()[`r1#v${rec.version}`].version, rec.version, 'start 应记录版本号');
  executor.stop('r1', 'manual');
  assert.equal(await waitRunning('r1', false), true);
  assert.equal(runState.has('r1'), false, '手动停止应清除运行意图');
});

test('服务关闭（shutdown）停止脚本但保留运行意图', async () => {
  const rec = store.submit('r2', { name: 'r2', script: IDLE, flow: FLOW, kind: 'automation', channel: 'shadow' });
  executor.start('r2', rec.version, connector);
  assert.equal(await waitRunning('r2', true), true);
  executor.stop('r2', 'shutdown');
  assert.equal(await waitRunning('r2', false), true);
  assert.equal(runState.read()[`r2#v${rec.version}`].version, rec.version, 'shutdown 后仍应保留版本供重启恢复');
});

test('restore：按清单版本恢复运行；脏条目（版本不存在）跳过并清理', async () => {
  const v1 = store.submit('r3', { name: 'r3', script: IDLE, flow: FLOW, kind: 'automation', channel: 'shadow' });
  store.publish('r3'); // v1 正式（上次真正在跑的版本）
  const v2 = store.submit('r3', { name: 'r3', script: IDLE, flow: FLOW, kind: 'automation', channel: 'shadow' }); // v2 新影子
  assert.notEqual(v1.version, v2.version, '发布后提交才分配新版本号');
  // 模拟上次运行的是 v1（不是最新 v2）
  runState.mark('r3', v1.version, 1000);
  // 塞一个版本不存在的脏条目
  runState.mark('ghost', 99);

  const result = executor.restore(connector);
  assert.equal(await waitRunning('r3', true), true);
  const list = executor.runningList().find((x) => x.id === 'r3');
  assert.equal(list.version, v1.version, '应按清单恢复到 v1，而非最新 v2');
  assert.equal(runState.read()[`r3#v${v1.version}`].version, v1.version, 'restore 重新 mark 后版本不变');

  const ghost = result.skipped.find((x) => x.id === 'ghost');
  assert.ok(ghost, '不存在的版本应被跳过');
  assert.match(ghost.reason, /版本不存在|源码为空/);
  assert.equal(runState.has('ghost'), false, '脏条目应被清理');

  executor.stop('r3', 'manual');
  await waitRunning('r3', false);
});

test('restore：清单里已运行的脚本跳过，不重复拉起', () => {
  const rec = store.submit('r4', { name: 'r4', script: IDLE, flow: FLOW, kind: 'automation', channel: 'shadow' });
  executor.start('r4', rec.version, connector);
  runState.mark('r4', rec.version); // 模拟清单 + 实例同在（如重复调用）
  const result = executor.restore(connector);
  const skip = result.skipped.find((x) => x.id === 'r4');
  assert.ok(skip && /已在运行/.test(skip.reason));
  executor.stop('r4', 'manual');
});
