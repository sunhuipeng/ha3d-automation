'use strict';
/* 自动重启窗口内 stop 失效回归（审计 2026-11-26 P0-3）：
 * 子进程自发崩溃（SIGKILL/致命错误）时实例还在 running 表中，onExit 走自动重启分支、
 * 意图保留——但 500ms 倒计时内实例已从 running 表摘除，历史上 stop() 查不到目标直接
 * 返回 false，用户明确停止的脚本会在窗口结束后自行"复活"。
 * 修复后 stop() 通过 pendingRestarts 取消挂起重启并清理运行意图。
 * 测试用 process.kill(pid) 模拟自发崩溃（区别于看门狗路径：那条路 stopInstance 已先
 * 摘除登记，wasRunning=false，本就不调度重启）。隔离 tmp 数据 + mock connector。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-restartstop-'));
const config = require('../server/config');
config.DATA = tmpRoot;
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');
const runState = require('../server/scripts/run-state');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function makeConnector() {
  return {
    ready: true, demo: false,
    isReady() { return this.ready; },
    getState() { return null; },
    listEntities() { return []; },
    callService: async () => ({ ok: true }),
  };
}

test('自动重启倒计时内 stop 应取消重启并清理运行意图', { timeout: 15000 }, async (t) => {
  t.after(() => { try { executor.stopAll(); } catch (e) { /* 清理 */ } });
  const conn = makeConnector();
  /* 常驻脚本挂死（无看门狗）：外部 SIGTERM 杀子进程模拟自发崩溃 → onExit(wasRunning=true)
   * → 进入自动重启倒计时（maxRestarts 默认 3），运行意图保留。 */
  const rec = store.submit('rstop', {
    name: 'rstop', kind: 'automation', flow: FLOW, channel: 'production',
    script: "ctx.log('info', 'started'); await new Promise(() => {});",
  });
  executor.start('rstop', rec.version, conn);
  assert.equal(executor.isRunning('rstop'), true);

  /* 等实例登记出现 pid（fork spawn 异步） */
  let pid = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 3000 && !pid) {
    pid = (executor.runningList().find((r) => r.id === 'rstop') || {}).pid || null;
    if (!pid) await wait(30);
  }
  assert.ok(pid, '应能从 runningList 拿到子进程 pid');

  /* 自发崩溃：杀掉子进程（SIGTERM → 退出码 null ≠ 0 → 自动重启分支） */
  process.kill(pid);

  /* 轮询等待"实例退出且恰处于重启倒计时"：stop 返回 true 即代表取消了挂起重启 */
  let stopped = false;
  while (Date.now() - t0 < 5000) {
    if (!executor.isRunning('rstop')) {
      stopped = executor.stop('rstop', 'manual');
      if (stopped) break;
    }
    await wait(30);
  }
  assert.equal(stopped, true, '重启倒计时窗口内 stop 必须返回 true（取消挂起重启）');

  /* 窗口原定在退出后 500ms 到期：再等 1.2s 确认脚本没有复活 */
  await wait(1200);
  assert.equal(executor.isRunning('rstop'), false, '停止后脚本不能在重启窗口结束后复活');
  assert.equal(executor.versionRuntimeStatus('rstop', rec.version), 'stopped', '运行状态应归位 stopped');
  const desired = runState.read();
  assert.ok(!Object.keys(desired).some((k) => k.startsWith('rstop#')), '运行意图应已清除，下次重启不再恢复');
});
