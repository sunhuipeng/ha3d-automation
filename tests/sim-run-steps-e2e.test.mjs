'use strict';
/* sim_run_steps E2E：真实 worker + runner-core + 单一虚拟时钟，一次提交整组 steps 跑完。
 * 覆盖报告 §7.4 两个必测用例（大功率 3s 确认、到点加热 + 规避补开）及批量执行特有语义
 * （force 重建、断言失败非中断、failFast、publish 守卫）。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const config = require('../server/config');
config.DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-runsteps-e2e-'));
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
const connector = {
  demo: false,
  getState: () => ({ state: '0', attributes: {} }),
  listEntities: () => [],
  callService: async () => ({ ok: true }),
};

const POWER_SCRIPT = `
  ctx.actions({ setFlag: async () => {}, clearFlag: async () => {} });
  const h = ctx.hold({ expect: (v) => v >= 1200, satisfyMs: 3000, unsatisfyMs: 30000,
    nodeId: 'n_hold', label: '大功率' });
  h.watch(async (satisfied) => {
    const avoiding = await ctx.global.get('avoiding', false);
    if (satisfied && !avoiding) {
      ctx.log('info', '确认满足（持续 3000ms）');
      ctx.write('setFlag', '大功率', 'n_write', true);
      await ctx.global.set('avoiding', true);
    } else if (!satisfied && avoiding) {
      ctx.write('clearFlag', '回落', 'n_release', false);
      await ctx.global.set('avoiding', false);
    }
  });
  ctx.watch('sensor.power', async (next) => { h.value = Number(next && next.state) || 0; });
  await ctx.keepAlive();
`;

/* 到点加热：每秒轮询，nowSod 越过 input_datetime.timestamp 后到点加热一次；
 * 若正在规避则挂起（pendingStart），规避解除后由下一拍补开。 */
const HEATER_SCRIPT = `
  ctx.actions({ heatOn: async () => {}, markPending: async () => {} });
  const target = ctx.num(await ctx.ha.attr('input_datetime.timestamp', 'timestamp', 73800));
  let heated = false;
  let pendingMarked = false;
  async function tryHeat() {
    const sod = ctx.time.nowSod();
    if (sod < target) return;
    const av = await ctx.global.get('avoiding', false);
    if (av) {
      if (!pendingMarked) {
        ctx.write('markPending', '规避挂起', 'n_pending', true);
        await ctx.global.set('pendingStart', true);
        pendingMarked = true;
      }
      return;
    }
    if (!heated) {
      ctx.write('heatOn', '到点加热', 'n_heat', target);
      await ctx.global.set('heated', true);
      await ctx.global.set('pendingStart', false);
      heated = true;
    }
  }
  ctx.every(1000, () => tryHeat());
  await ctx.keepAlive();
`;

function submit(sid, script) {
  return store.submit(sid, { name: sid, script, flow: FLOW, channel: 'shadow', kind: 'automation' });
}

test('sim_run_steps 用例 A：大功率 3s 确认 + 回落重来（报告 §7.4）', async () => {
  const sid = 'rs-power';
  submit(sid, POWER_SCRIPT);
  const r = await executor.simRunSteps(sid, {
    startAt: '2026-11-26T20:29:55+08:00',
    seed: { entities: { 'sensor.power': { state: '950', attributes: {} } }, context: { global: { avoiding: false } } },
    steps: [
      { op: 'inject_entity', entityId: 'sensor.power', state: '1200' },
      { op: 'advance', ms: 2999 },
      { op: 'assert', label: '2999ms 不得写', noWrites: true },
      { op: 'advance', ms: 1 },
      {
        op: 'assert', label: '3000ms 写一次',
        writes: [
          { kind: 'context', op: 'contextSet', args: ['avoiding', true] },
          { kind: 'write', op: 'setFlag', nodeId: 'n_write', args: [true] },
        ],
        context: [{ scope: 'global', key: 'avoiding', value: true }],
        logs: ['确认满足'],
      },
      { op: 'inject_entity', entityId: 'sensor.power', state: '950' },
      { op: 'advance', ms: 29999 },
      { op: 'assert', label: '回落未满 30000ms 不得写', noWrites: true },
      { op: 'advance', ms: 1 },
      {
        op: 'assert', label: '回落写一次',
        writes: [
          { kind: 'context', op: 'contextSet', args: ['avoiding', false] },
          { kind: 'write', op: 'clearFlag', nodeId: 'n_release', args: [false] },
        ],
        context: [{ scope: 'global', key: 'avoiding', value: false }],
      },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(r.total, 4);
  assert.equal(r.passed, 4);
  assert.equal(r.failed, 0);
  assert.equal(r.aborted, false);
  assert.equal(r.final.clockNow, '2026-11-26T12:30:28.000Z');
  await executor.switchVerifyMode(sid, 'follow');
  executor.stop(sid, 'test-cleanup', 1);
});

test('sim_run_steps 用例 B：到点加热一次 + 规避挂起与解除补开（报告 §7.4）', async () => {
  const sid = 'rs-heater';
  submit(sid, HEATER_SCRIPT);
  const seed = { entities: { 'input_datetime.timestamp': { state: '', attributes: { timestamp: 73800 } } }, context: { global: { avoiding: false } } };

  /* 1) 不规避：推进 10s，越过 73800（20:30:00）只加热一次 */
  const r1 = await executor.simRunSteps(sid, {
    startAt: '2026-11-26T20:29:55+08:00', seed,
    steps: [
      { op: 'advance', ms: 10000 },
      {
        op: 'assert', label: '到点只加热一次',
        writes: [
          { kind: 'context', op: 'contextSet', args: ['heated', true] },
          { kind: 'write', op: 'heatOn', nodeId: 'n_heat', args: [73800] },
          { kind: 'context', op: 'contextSet', args: ['pendingStart', false] },
        ],
        context: [{ scope: 'global', key: 'heated', value: true }],
      },
    ],
  });
  assert.equal(r1.ok, true, JSON.stringify(r1.results));

  /* 2) force 重建：播种 avoiding=true，到点只挂起不加热；解除后下一拍补开。
   *    传 startAt/seed 触发强制重建到干净世界（验证 force 语义）。 */
  const seedAvoid = { entities: seed.entities, context: { global: { avoiding: true } } };
  const r2 = await executor.simRunSteps(sid, {
    startAt: '2026-11-26T20:29:55+08:00', seed: seedAvoid,
    steps: [
      { op: 'advance', ms: 10000 },
      {
        op: 'assert', label: '规避挂起不加热',
        writes: [
          { kind: 'context', op: 'contextSet', args: ['pendingStart', true] },
          { kind: 'write', op: 'markPending', nodeId: 'n_pending' },
        ],
        noWrites: ['heatOn'],
        context: [{ scope: 'global', key: 'pendingStart', value: true }],
      },
      { op: 'inject_context', scope: 'global', key: 'avoiding', value: false },
      { op: 'advance', ms: 1000 },
      {
        op: 'assert', label: '解除后补开',
        writes: [
          { kind: 'context', op: 'contextSet', args: ['heated', true] },
          { kind: 'write', op: 'heatOn', nodeId: 'n_heat' },
          { kind: 'context', op: 'contextSet', args: ['pendingStart', false] },
        ],
        context: [
          { scope: 'global', key: 'heated', value: true },
          { scope: 'global', key: 'pendingStart', value: false },
        ],
      },
    ],
  });
  assert.equal(r2.ok, true, JSON.stringify(r2.results));
  assert.equal(r2.total, 2);
  await executor.switchVerifyMode(sid, 'follow');
  executor.stop(sid, 'test-cleanup', 1);
});

test('sim_run_steps：断言失败默认收集全部失败点，failFast 首败即停', async () => {
  const sid = 'rs-fail';
  submit(sid, 'await ctx.keepAlive();');
  const seed = { entities: {}, context: { global: {} } };
  const steps = [
    { op: 'assert', label: 'bad-1', writes: [{ op: 'ghost' }] },
    { op: 'assert', label: 'ok', noWrites: true },
    { op: 'assert', label: 'bad-2', writes: [{ op: 'phantom' }] },
  ];
  const full = await executor.simRunSteps(sid, { startAt: '2026-11-26T20:29:55+08:00', seed, steps });
  assert.equal(full.ok, false);
  assert.equal(full.executed, 3, '失败不中断，仍跑完三步');
  assert.equal(full.failed, 2);
  assert.equal(full.passed, 1);

  const fast = await executor.simRunSteps(sid, { steps, failFast: true });
  assert.equal(fast.ok, false);
  assert.equal(fast.executed, 1, 'failFast 在首个失败断言处停止');
  await executor.switchVerifyMode(sid, 'follow');
  executor.stop(sid, 'test-cleanup', 1);
});

test('sim_run_steps：默认每次重建、continue:true 才复用会话，publish 守卫仍在', async () => {
  const sid = 'rs-reuse';
  const rec = submit(sid, POWER_SCRIPT);
  const seed = { entities: { 'sensor.power': { state: '950', attributes: {} } }, context: { global: { avoiding: false } } };
  const writesOnce = [
    { op: 'inject_entity', entityId: 'sensor.power', state: '1200' },
    { op: 'advance', ms: 3000 },
    { op: 'assert', label: '写一次', writes: [
      { kind: 'context', op: 'contextSet', args: ['avoiding', true] },
      { kind: 'write', op: 'setFlag', nodeId: 'n_write', args: [true] },
    ] },
  ];

  /* ① 不带 continue：即便上一轮留下 avoiding=true 的上下文，也必须从种子重建，
   *    断言能重新观察到一次写意图（状态没被上一轮吃掉）。 */
  const r1 = await executor.simRunSteps(sid, { startAt: '2026-11-26T20:29:55+08:00', seed, steps: writesOnce });
  assert.equal(r1.ok, true, JSON.stringify(r1.results));
  const r2 = await executor.simRunSteps(sid, { startAt: '2026-11-26T20:29:55+08:00', seed, steps: writesOnce });
  assert.equal(r2.ok, true, '默认重建后同一用例可独立重跑：' + JSON.stringify(r2.results));

  /* ② continue:true：接着当前世界跑，第二轮不该再写（avoiding 已是 true）。 */
  const r3 = await executor.simRunSteps(sid, { steps: [
    { op: 'inject_entity', entityId: 'sensor.power', state: '1300' },
    { op: 'advance', ms: 3000 },
    { op: 'assert', label: '续跑不重复写', noWrites: true },
  ], continue: true });
  assert.equal(r3.ok, true, JSON.stringify(r3.results));

  /* ③ continue 与 startAt 互斥 */
  await assert.rejects(
    () => executor.simRunSteps(sid, { continue: true, startAt: '2026-11-26T20:29:55+08:00', steps: [] }),
    /continue/
  );

  assert.throws(() => executor.publish(sid, rec.version), /仿真/);
  await executor.switchVerifyMode(sid, 'follow');
  executor.stop(sid, 'test-cleanup', rec.version);
});
