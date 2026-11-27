'use strict';
/* P2 E2E：交互式断言（sim_assert）、标记回滚（mark/rewind）、用例导出与重放（sim_export / sim_run_fixture）。
 * 真实 worker + runner-core + 虚拟时钟，验证「探索 → 导出 → 一键回归」闭环。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-sim-p2-'));
require('../server/config').DATA = tmpRoot;
/* 用例目录已并入 skill/.fixtures（不再是 data/fixtures）：测试必须把它也指到临时目录，
 * 否则会往真项目的可复用用例库里写 p2-export / p2-drift 这类测试数据。 */
require('../server/config').FIXTURES = path.join(tmpRoot, 'fixtures');
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
const START = '2026-11-26T20:29:55+08:00';
const SEED = {
  entities: { 'sensor.power': { state: '950', attributes: {} } },
  context: { global: { avoiding: false } },
};

function submit(sid, script) {
  return store.submit(sid, { name: sid, script, flow: FLOW, channel: 'shadow', kind: 'automation' });
}

function powerScript(op = 'setFlag') {
  return `
    ctx.actions({ setFlag: async () => {}, ${op}: async () => {} });
    const h = ctx.hold({ expect: (v) => v >= 1200, satisfyMs: 3000, unsatisfyMs: 30000,
      nodeId: 'n_hold', label: '大功率' });
    h.watch(async (s) => {
      const avoiding = await ctx.global.get('avoiding', false);
      if (s && !avoiding) {
        await ctx.write('${op}', '大功率', 'n_write', true);
        await ctx.global.set('avoiding', true);
      }
    });
    ctx.watch('sensor.power', async (n) => { h.value = Number(n && n.state) || 0; });
    await ctx.keepAlive();
  `;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function ready(sid, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const s = await executor.simSnapshot(sid, { include: ['execution'] });
      if (s && s.execution && s.execution.runCount > 0) return s;
    } catch (e) { /* 未就绪 */ }
    await sleep(50);
  }
  throw new Error('仿真会话就绪超时');
}

test('P2：探索 → sim_assert 断言 → 导出用例 → 重放通过', async () => {
  const sid = 'p2-export';
  const rec = submit(sid, powerScript());
  await executor.switchVerifyMode(sid, 'simulate', { startAt: START, seed: SEED });
  await ready(sid);

  /* 探索：注入大功率并快进 3s */
  await executor.simInject(sid, { entity: { entityId: 'sensor.power', state: '1200' } });
  await executor.simAdvance(sid, 3000);

  /* 交互式断言（DSL）：写意图与上下文都能直接查 */
  const a = await executor.simAssert(sid, {
    label: '大功率确认写了',
    expect: [
      { path: 'writes[0].op', eq: 'setFlag' },
      { path: 'writes[0].nodeId', eq: 'n_write' },
      { path: 'context.global.avoiding', eq: true },
      { path: 'execution.runCount', gte: 1 },
    ],
  });
  assert.equal(a.ok, true, JSON.stringify(a.checks));
  assert.ok(a.checks[0].actual.some((x) => x.path === 'writes[0].op'));

  /* 导出 */
  const ex = await executor.simExport(sid, 'power-3s');
  assert.equal(ex.steps, 2, 'tape 应含一次注入 + 一次推进');
  assert.equal(ex.writes, 2, '写意图：contextSet + setFlag');
  const file = path.join(tmpRoot, 'fixtures', sid, 'power-3s.json');
  assert.ok(fs.existsSync(file), '用例应落盘');
  const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(fx.startAt, '2026-11-26T12:29:55.000Z');
  assert.equal(fx.scriptVersion, rec.version);
  assert.ok(fx.scriptSha, '应记录脚本 sha 以便检测改版');

  /* 重放：默认重建世界 + 全序列写意图断言 */
  const run = await executor.simRunFixture(sid, 'power-3s');
  assert.equal(run.ok, true, JSON.stringify(run.results));
  assert.equal(run.fixture.versionDrift, false);
  assert.equal(run.total, 1);

  /* 列表 */
  const list = executor.simListFixtures(sid);
  assert.deepEqual(list.fixtures.map((f) => f.name), ['power-3s']);

  await executor.switchVerifyMode(sid, 'follow');
  executor.stop(sid, 'test-cleanup', rec.version);
});

test('P2：脚本改版后重放，versionDrift 与断言同时暴露', async () => {
  const sid = 'p2-drift';
  const rec = submit(sid, powerScript());
  await executor.switchVerifyMode(sid, 'simulate', { startAt: START, seed: SEED });
  await ready(sid);
  await executor.simInject(sid, { entity: { entityId: 'sensor.power', state: '1200' } });
  await executor.simAdvance(sid, 3000);
  await executor.simExport(sid, 'before-change');

  /* 原地覆盖影子：版号不变，写操作换名 → 断言应失败，且 sha 漂移被标出 */
  submit(sid, powerScript('setFlagV2'));
  const run = await executor.simRunFixture(sid, 'before-change');
  assert.equal(run.fixture.versionDrift, true, 'sha 变化必须被识别');
  assert.equal(run.ok, false);
  assert.equal(run.failed, 1);

  await executor.switchVerifyMode(sid, 'follow');
  executor.stop(sid, 'test-cleanup', rec.version);
});

/* 回归：用 sim_run_steps 批量驱动的会话，导出成 fixture 时 advance 步骤不能丢。
 * 曾经 runSteps 直接调 clock.advance（绕过 tape 记录），导致 fixture 只剩注入、
 * 重放时时钟不动、写意图全空——真机用例导出后一重放就暴露。 */
test('P2：run_steps 驱动的会话导出后含 advance，重放能复现写意图', async () => {
  const sid = 'p2-export-steps';
  const rec = submit(sid, powerScript());
  await executor.switchVerifyMode(sid, 'simulate', { startAt: START, seed: SEED });
  await ready(sid);

  const run = await executor.simRunSteps(sid, {
    continue: true,
    steps: [
      { op: 'inject_entity', entityId: 'sensor.power', state: '1200' },
      { op: 'advance', ms: 3000 },
      { op: 'assert', label: '大功率确认写了一次', expect: [{ path: 'writes[0].op', eq: 'setFlag' }] },
    ],
  });
  assert.equal(run.ok, true, JSON.stringify(run.results));

  const ex = await executor.simExport(sid, 'from-steps');
  assert.equal(ex.steps, 2, 'tape 必须含注入 + 推进两条');
  const file = path.join(tmpRoot, 'fixtures', sid, 'from-steps.json');
  const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(fx.steps.filter((s) => s.op === 'advance').length, 1, 'advance 必须被记进 tape');
  assert.equal(fx.steps.filter((s) => s.op === 'inject_entity').length, 1);

  const replay = await executor.simRunFixture(sid, 'from-steps');
  assert.equal(replay.ok, true, JSON.stringify(replay.results));
  assert.equal(replay.fixture.versionDrift, false);

  await executor.switchVerifyMode(sid, 'follow');
  executor.stop(sid, 'test-cleanup', rec.version);
});

test('P2：mark/rewind 让同一会话换个输入再验一次（时钟不回退）', async () => {
  const sid = 'p2-rewind';
  const rec = submit(sid, powerScript());
  await executor.switchVerifyMode(sid, 'simulate', { startAt: START, seed: SEED });
  await ready(sid);

  const m = await executor.simMark(sid, 'idle');
  assert.equal(m.mark, 'idle');

  /* 分支一：1200W 满 3s，应写一次 */
  await executor.simInject(sid, { entity: { entityId: 'sensor.power', state: '1200' } });
  await executor.simAdvance(sid, 3000);
  const a1 = await executor.simAssert(sid, { expect: { path: 'writes.length', eq: 2 } });
  assert.equal(a1.ok, true, JSON.stringify(a1.checks));

  /* 回滚输入世界：实体回到 950、上下文回到 false（时钟停在 3000ms，脚本状态不回退） */
  const rw = await executor.simRewind(sid, 'idle');
  assert.equal(rw.at, 0);
  assert.equal(rw.clockAt, 3000);
  const snap = await executor.simSnapshot(sid, { include: ['entities', 'context', 'execution'] });
  assert.equal(snap.entities['sensor.power'].state, '950');
  assert.equal(snap.context.global.avoiding, false);

  /* 分支二：注入 900W（大功率不成立），推进 5s 不应再有写意图 */
  await executor.simInject(sid, { entity: { entityId: 'sensor.power', state: '900' } });
  await executor.simAdvance(sid, 5000);
  const a2 = await executor.simAssert(sid, { label: '低功率不写', noWrites: true });
  assert.equal(a2.ok, true, JSON.stringify(a2.checks));

  await executor.switchVerifyMode(sid, 'follow');
  executor.stop(sid, 'test-cleanup', rec.version);
});

/* 回归：自带 assert 的用例重放时不再跳过全序列断言——追尾断言用 since:0 绕开游标消耗，
 * 分段断言与全序列校验并存（旧实现直接跳过，会漏掉全序列这层校验）。 */
test('P2：自带 assert 的用例重放时也追加 since:0 全序列断言', async () => {
  const sid = 'p2-own-asserts';
  const rec = submit(sid, powerScript());
  await executor.switchVerifyMode(sid, 'simulate', { startAt: START, seed: SEED });
  await ready(sid);

  const dir = path.join(tmpRoot, 'fixtures', sid);
  fs.mkdirSync(dir, { recursive: true });
  const manual = {
    scriptId: sid,
    name: 'own-asserts',
    startAt: START,
    seed: SEED,
    steps: [
      { op: 'inject_entity', entityId: 'sensor.power', state: '1200' },
      { op: 'advance', ms: 3000 },
      /* 自带断言用 expect DSL（看世界终值），不消耗写意图条数口径 */
      { op: 'assert', label: '分段：防抖后已写入', expect: { path: 'context.global.avoiding', eq: true } },
    ],
    expected: { writes: [
      { kind: 'write', op: 'setFlag', nodeId: 'n_write', args: [true] },
      { kind: 'context', op: 'contextSet', args: ['avoiding', true] },
    ] },
  };
  fs.writeFileSync(path.join(dir, 'own-asserts.json'), JSON.stringify(manual), 'utf8');

  const run = await executor.simRunFixture(sid, 'own-asserts');
  assert.equal(run.ok, true, JSON.stringify(run.results));
  assert.equal(run.total, 2, '分段断言 + 追加的全序列断言都要跑');

  await executor.switchVerifyMode(sid, 'follow');
  executor.stop(sid, 'test-cleanup', rec.version);
});

/* 回归：用例目录与资产库合并后（skill/.fixtures 既是导出落点又是手写用例的家），
 * 导出不能静默覆盖带断言的手写用例——导出的 fixture 没有断言，覆盖等于把资产降级。 */
test('P2：导出同名手写用例默认拒绝，force 才覆盖', async () => {
  const sid = 'p2-export-guard';
  const rec = submit(sid, powerScript());
  await executor.switchVerifyMode(sid, 'simulate', { startAt: START, seed: SEED });
  await ready(sid);

  const dir = path.join(tmpRoot, 'fixtures', sid);
  fs.mkdirSync(dir, { recursive: true });
  const manual = { scriptId: sid, name: 'handwritten', steps: [{ op: 'assert', label: '手写断言', noWrites: true }] };
  fs.writeFileSync(path.join(dir, 'handwritten.json'), JSON.stringify(manual), 'utf8');

  await assert.rejects(() => executor.simExport(sid, 'handwritten'), /拒绝/, '带断言的手写用例不应被覆盖');
  const forced = await executor.simExport(sid, 'handwritten', { force: true });
  assert.equal(forced.ok, true, 'force:true 时应允许覆盖');
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'handwritten.json'), 'utf8'));
  assert.ok(after.steps.every((s) => s.op !== 'assert'), '覆盖后应变成导出流水（无断言）');

  await executor.switchVerifyMode(sid, 'follow');
  executor.stop(sid, 'test-cleanup', rec.version);
});
