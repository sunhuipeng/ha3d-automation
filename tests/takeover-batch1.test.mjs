'use strict';
/* 接管方案批次一：kind 元数据 + 一次性触发守卫。
 * 用独立临时 DATA，避免污染真实 data；DEV_MODE 不设（本测试不碰真实 HA，connector 全 mock）。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-takeover-'));
const config = require('../server/config');
config.DATA = tmpRoot;
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
const connector = {
  demo: false,
  getState: () => ({ state: 'off', attributes: {} }),
  listEntities: () => [],
  callService: async () => ({ ok: true }),
};

function waitDone(sid, timeoutMs = 8000) {
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

test('kind 校验：非法值 fail-fast', () => {
  assert.throws(() => store.submit('kindbad', {
    name: '非法种类', script: `ctx.log('info','x');`, flow: FLOW, kind: 'bogus',
  }), /kind 非法/);
});

test('kind 继承：新脚本默认 automation，迭代与发布不丢', () => {
  const rec = store.submit('kind1', {
    name: '默认种类', script: `ctx.log('info','x');`, flow: FLOW,
  });
  assert.equal(rec.meta.kind, 'automation');
  assert.equal(store.list().find((s) => s.id === 'kind1').kind, 'automation');

  const rec2 = store.submit('kind2', {
    name: '场景种类', script: `ctx.log('info','x');`, flow: FLOW, kind: 'scene',
  });
  assert.equal(rec2.meta.kind, 'scene');
  assert.equal(rec2.meta.kind, 'scene');
  /* 覆盖影子不传 kind → 继承 */
  const rec3 = store.submit('kind2', {
    name: '场景种类改版', script: `ctx.log('info','y');`, flow: FLOW,
  });
  assert.equal(rec3.meta.kind, 'scene', '迭代必须继承上一版 kind');
  /* 发布后新开影子仍继承 */
  store.publish('kind2', rec3.version);
  const rec4 = store.submit('kind2', {
    name: '场景新候选', script: `ctx.log('info','z');`, flow: FLOW, newVersion: true,
  });
  assert.equal(rec4.meta.kind, 'scene', '新版本号仍继承上一版 kind');
});

test('runnerTimeoutMs 脚本级覆盖：校验与继承', () => {
  assert.throws(() => store.submit('timeoutbad', {
    name: '非法超时', script: `ctx.log('info','x');`, flow: FLOW, runnerTimeoutMs: 10,
  }), /runnerTimeoutMs 非法/);
  const r = store.submit('timeout1', {
    name: '长延时脚本', script: `ctx.log('info','x');`, flow: FLOW,
    kind: 'script', runnerTimeoutMs: 35 * 60 * 1000,
  });
  assert.equal(r.meta.runnerTimeoutMs, 35 * 60 * 1000);
  const r2 = store.submit('timeout1', {
    name: '长延时脚本改版', script: `ctx.log('info','y');`, flow: FLOW,
  });
  assert.equal(r2.meta.runnerTimeoutMs, 35 * 60 * 1000, '迭代必须继承脚本级超时');
});

test('trigger 守卫：无正式版 / 常驻脚本 / 重复触发均拒绝', async () => {
  /* 只有影子 → 拒绝 */
  store.submit('trg1', { name: '仅影子', script: `ctx.log('info','x');`, flow: FLOW, kind: 'script' });
  assert.throws(() => executor.trigger('trg1', connector), /没有正式版本/);

  /* 常驻正式版 → 拒绝按次触发 */
  const live = store.submit('trg2', {
    name: '常驻自动化', script: `for (;;) { await ctx.sleep(1000); }`, flow: FLOW,
    channel: 'production',
  });
  assert.throws(() => executor.trigger('trg2', connector), /常驻自动化不能按次触发/);

  /* 正式短脚本 → 可触发，跑完自动清理；执行中重复触发拒绝 */
  const oneshot = store.submit('trg3', {
    name: '一次性场景', script: `await ctx.sleep(300); ctx.log('info','done');`, flow: FLOW,
    channel: 'production', kind: 'scene',
  });
  const r = executor.trigger('trg3', connector);
  assert.equal(r.version, oneshot.version);
  assert.equal(executor.isRunning('trg3'), true);
  assert.throws(() => executor.trigger('trg3', connector), /正在执行中/);
  await waitDone('trg3');
  assert.equal(executor.isRunning('trg3'), false, '一次性脚本跑完自动清理');

  /* restartable：执行中重复触发 = 停旧启新（对齐 HA script mode:restart） */
  const restart = store.submit('trg4', {
    name: '可重入吸氧', script: `await ctx.sleep(5000); ctx.log('info','done');`, flow: FLOW,
    channel: 'production', kind: 'script', restartable: true,
  });
  executor.trigger('trg4', connector);
  const r2 = executor.trigger('trg4', connector);
  assert.equal(r2.version, restart.version, '可重入脚本重复触发应停旧启新而非报错');
  assert.ok(executor.isRunning('trg4'), '重启后实例应在运行');
  executor.stop('trg4', 'test');
});

test('trigger 影子通道：channel=shadow 触发影子版本，跑完自动清理', async () => {
  /* trg1 只有影子版本（前面测试已提交，kind=script）：正式通道拒绝、影子通道放行 */
  const r = executor.trigger('trg1', connector, 'shadow');
  assert.equal(r.mode, 'shadow');
  assert.ok(executor.isRunning('trg1'), '影子实例应在运行');
  await waitDone('trg1');
  assert.equal(executor.isRunning('trg1'), false, '影子一次性脚本跑完同样自动清理');

  /* 缺省通道仍是 production：trg1 无正式版，保持拒绝（口径不回归） */
  assert.throws(() => executor.trigger('trg1', connector), /没有正式版本/);

  /* 非法通道值 → 缺省按 production 处理：trg1 无正式版，故仍拒绝（缺省语义不外漏） */
  assert.throws(() => executor.trigger('trg1', connector, 'bogus'), /没有正式版本/);
});
