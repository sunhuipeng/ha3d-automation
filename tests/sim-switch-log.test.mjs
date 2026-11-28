'use strict';
/* 切换仿真的框架日志（[模式切换]）必须与脚本日志同格式：带虚拟时刻 at、落进 sim.log。
 * 回归点：曾只广播 sim:true 却无 at、不落盘，前端渲染成墙钟时间，和脚本日志的 +X.Xs 混排，
 * 且刷新页面后这条消失。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-simlog-'));
const config = require('../server/config');
config.DATA = tmpRoot;
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeConnector() {
  return { ready: true, demo: false, isReady() { return this.ready; }, getState() { return null; }, listEntities() { return []; }, callService: async () => ({ ok: true }) };
}

test('clearSimLog 清空 + appendSimLog 追加：框架日志与 worker 脚本日志同文件共存', () => {
  store.submit('simlogunit', { name: 'simlogunit', script: 'ctx.log("info","x");', flow: FLOW, kind: 'automation', channel: 'shadow' });
  store.appendSimLog('simlogunit', 1, { level: 'info', message: 'old' });
  store.clearSimLog('simlogunit', 1);
  assert.deepEqual(store.readSimLogs('simlogunit', 1), [], '清空后无旧日志');
  store.appendSimLog('simlogunit', 1, { at: 0, level: 'warn', message: '[模式切换] follow → simulate' });
  store.appendSimLog('simlogunit', 1, { at: 3000, level: 'info', message: 'script line' });
  const logs = store.readSimLogs('simlogunit', 1);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].at, 0, '框架日志带虚拟时刻 0');
  assert.equal(logs[1].at, 3000, '脚本日志保留自身虚拟时刻');
});

test('真实切仿真：模式切换日志落 sim.log 且带 at，不写真实日志', async (t) => {
  t.after(() => { try { executor.stopAll(); } catch (e) {} });
  const conn = makeConnector();
  store.submit('simloge2e', {
    name: 'simloge2e', script: 'ctx.log("info","boot"); await new Promise(()=>{});', flow: FLOW, kind: 'automation', channel: 'shadow',
  });
  const hub = require('../server/lib/ws-hub');
  const orig = hub.broadcast;
  const seen = [];
  hub.broadcast = (p) => { seen.push({ ...p }); return orig(p); };
  try {
    const r = await executor.switchVerifyMode('simloge2e', 'simulate', { startAt: '2026-11-28T03:00:00.000Z', seed: {} });
    assert.equal(r.verifyMode, 'simulate');
    await wait(200);
  } finally { hub.broadcast = orig; }

  const switchLog = seen.find((p) => p.event === 'log' && /模式切换/.test(p.message || ''));
  assert.ok(switchLog, '广播里应有模式切换日志');
  assert.equal(switchLog.sim, true);
  assert.equal(switchLog.at, 0, '广播带虚拟时刻 at=0，前端显示 +0.0s 而非墙钟');

  const simLogs = store.readSimLogs('simloge2e', 1);
  assert.ok(simLogs.some((l) => /模式切换/.test(l.message)), '模式切换日志落进 sim.log，刷新后仍在');
  assert.ok(simLogs.some((l) => l.at === 0), '落盘日志带 at');

  const realLogs = store.readLogs('simloge2e', 1);
  assert.equal(realLogs.some((l) => /模式切换/.test(l.message)), false, '仿真日志不写真实 v<n>.log');
});
