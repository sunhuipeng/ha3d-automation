'use strict';
/* 影子双模式验证 E2E：真实 worker + 真实 runner-core + VirtualClock + SimHost。
 * 用例 A（大功率 3s 确认）：1200W 推进 2999ms 不得写，再 +1ms 写一次；
 * 回落 950W 开始计时，推进未满不得写。写意图取仿真快照（硬证据）。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-sim-e2e-'));
const config = require('../server/config');
config.DATA = tmpRoot;
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');
const { join } = path;

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
const connector = {
  demo: false,
  getState: () => ({ state: '0', attributes: {} }),
  listEntities: () => [],
  callService: async () => ({ ok: true }),
};

/* 影子脚本：订阅功率，用 ctx.hold 做 3s 满足 / 30s 回落双边确认，确认后 ctx.write 置标志。
 * write 的第三参数是 nodeId，供写意图归因。 */
const POWER_SCRIPT = `
  ctx.actions({
    setFlag: async () => {},
    clearFlag: async () => {},
  });
  const h = ctx.hold({ expect: (v) => v >= 1200, satisfyMs: 3000, unsatisfyMs: 30000,
    nodeId: 'n_hold', label: '大功率' });
  h.watch(async (satisfied) => {
    const avoiding = await ctx.global.get('avoiding', false);
    if (satisfied && !avoiding) {
      ctx.write('setFlag', '大功率', 'n_write', true);
      ctx.global.set('avoiding', true);
    } else if (!satisfied && avoiding) {
      ctx.write('clearFlag', '回落', 'n_release', false);
      ctx.global.set('avoiding', false);
    }
  });
  ctx.watch('sensor.power', async (next) => {
    h.value = Number(next && next.state) || 0;
  }, { debounceMs: 0 }); // 本用例验证 hold 精确计时，关闭 watch 缺省 300ms 防抖
  await ctx.keepAlive();
`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitSnapshot(sid, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try { return await executor.simSnapshot(sid, {}); } catch (e) { await sleep(50); }
  }
  throw new Error('等待仿真快照就绪超时');
}

test('仿真 E2E：切换 simulate → 注入 → advance → 写意图断言 → 切回 follow', async () => {
  const sid = 'sim-e2e-power';
  const rec = store.submit(sid, {
    name: '仿真大功率', script: POWER_SCRIPT, flow: FLOW, channel: 'shadow', kind: 'automation',
  });

  /* 1) 切到 simulate，播种实体与上下文 */
  const sw = await executor.switchVerifyMode(sid, 'simulate', {
    startAt: '2026-11-26T20:29:55+08:00',
    seed: {
      entities: { 'sensor.power': { state: '950', attributes: {} } },
      context: { global: { avoiding: false } },
    },
  });
  assert.equal(sw.to, 'simulate');
  assert.equal(sw.from, 'stopped');
  await waitSnapshot(sid);

  /* 2) 注入 1200W，推进 2999ms：不得写 */
  await executor.simInject(sid, { entity: { entityId: 'sensor.power', state: '1200' } });
  await executor.simAdvance(sid, 2999);
  let snap = await executor.simSnapshot(sid, {});
  assert.equal(snap.verifyMode, 'simulate');
  assert.equal(snap.entities['sensor.power'].state, '1200');
  assert.equal(snap.writes.filter((w) => w.kind === 'write').length, 0, '2999ms 不得写');
  assert.ok(snap.logs.some((l) => /满足计时/.test(l.message)), '应有满足计时日志');
  assert.ok(snap.timers.some((t) => /满足计时/.test(t.label)), 'timers 应带 hold 标签（§7.6）');

  /* 3) 再推进 1ms：写一次 setFlag */
  await executor.simAdvance(sid, 1);
  snap = await executor.simSnapshot(sid, {});
  const writes = snap.writes.filter((w) => w.kind === 'write');
  assert.equal(writes.length, 1, '3000ms 应写一次');
  assert.equal(writes[0].op, 'setFlag');
  assert.equal(writes[0].nodeId, 'n_write');
  assert.ok(writes[0].at >= 3000, `写意图 at=${writes[0].at} 应 >= 3000`);
  assert.equal(snap.context.global.avoiding, true);

  /* 4) 回落 950W：未满 30000ms 不写，随后补一次 clearFlag */
  await executor.simInject(sid, { entity: { entityId: 'sensor.power', state: '950' } });
  await executor.simAdvance(sid, 29999);
  snap = await executor.simSnapshot(sid, {});
  assert.equal(snap.writes.filter((w) => w.kind === 'write').length, 1, '回落未满不得写');
  await executor.simAdvance(sid, 1);
  snap = await executor.simSnapshot(sid, {});
  const allWrites = snap.writes.filter((w) => w.kind === 'write');
  assert.equal(allWrites.length, 2);
  assert.equal(allWrites[1].op, 'clearFlag');
  assert.equal(snap.context.global.avoiding, false);

  /* 5) L1 观测：timers / watchers / execution 字段齐备 */
  assert.ok(Array.isArray(snap.timers));
  assert.ok(snap.watchers.some((w) => w.kind === 'entity' && w.key === 'sensor.power'));
  assert.ok(snap.execution);

  /* 6) 切回 follow：虚拟世界销毁，影子以真实数据重启 */
  const back = await executor.switchVerifyMode(sid, 'follow');
  assert.equal(back.to, 'follow');
  assert.equal(back.idempotent, false);
  await assert.rejects(() => executor.simSnapshot(sid, {}), /没有仿真/);
  executor.stop(sid, 'test-cleanup', rec.version);
});

test('仿真 E2E：满足计时中途回落再升回，计时从 0 重来', async () => {
  const sid = 'sim-e2e-reset';
  store.submit(sid, {
    name: '重置计时', script: POWER_SCRIPT, flow: FLOW, channel: 'shadow', kind: 'automation',
  });
  await executor.switchVerifyMode(sid, 'simulate', {
    startAt: '2026-11-26T20:29:55+08:00',
    seed: { entities: { 'sensor.power': { state: '950', attributes: {} } }, context: { global: { avoiding: false } } },
  });
  await waitSnapshot(sid);

  /* 升 1200 → 2900ms → 降 950 → 升回 1200 → 只推进 200ms（并入未到 3000）不得写 */
  await executor.simInject(sid, { entity: { entityId: 'sensor.power', state: '1200' } });
  await executor.simAdvance(sid, 2900);
  await executor.simInject(sid, { entity: { entityId: 'sensor.power', state: '950' } });
  await executor.simAdvance(sid, 100);           // 回落计时开始
  await executor.simInject(sid, { entity: { entityId: 'sensor.power', state: '1200' } });
  await executor.simAdvance(sid, 2900);          // 从 0 重新计时，仅 2900ms
  let snap = await executor.simSnapshot(sid, {});
  assert.equal(snap.writes.filter((w) => w.kind === 'write').length, 0, '重置后未满 3000ms 不得写');
  await executor.simAdvance(sid, 100);
  snap = await executor.simSnapshot(sid, {});
  assert.equal(snap.writes.filter((w) => w.kind === 'write').length, 1, '满 3000ms 写一次');
  await executor.switchVerifyMode(sid, 'follow');
  executor.stop(sid, 'test-cleanup', 1);
});

test('仿真 E2E：publish 守卫拒绝含 simulate 实例的发布', async () => {
  const sid = 'sim-e2e-guard';
  const rec = store.submit(sid, {
    name: '守卫', script: 'await ctx.keepAlive();', flow: FLOW, channel: 'shadow', kind: 'automation',
  });
  await executor.switchVerifyMode(sid, 'simulate', { seed: { entities: {} } });
  await waitSnapshot(sid);
  assert.throws(() => executor.publish(sid, rec.version), /仿真/);
  await executor.switchVerifyMode(sid, 'follow');
  executor.stop(sid, 'test-cleanup', rec.version);
});

test('仿真 E2E：日志写入独立文件 v<n>.sim.log，不落版本日志', async () => {
  const sid = 'sim-e2e-logfile';
  const rec = store.submit(sid, {
    name: '日志文件', script: POWER_SCRIPT, flow: FLOW, channel: 'shadow', kind: 'automation',
  });
  await executor.switchVerifyMode(sid, 'simulate', {
    startAt: '2026-11-26T20:29:55+08:00',
    seed: { entities: { 'sensor.power': { state: '950', attributes: {} } }, context: { global: { avoiding: false } } },
  });
  await waitSnapshot(sid);
  await executor.simInject(sid, { entity: { entityId: 'sensor.power', state: '1200' } });
  await executor.simAdvance(sid, 3000); // 触发满足计时日志

  /* 写流是异步 flush：轮询文件，最多 ~1.5s */
  const file = join(tmpRoot, 'runtime', sid, `v${rec.version}.sim.log`);
  let lines = [];
  for (let i = 0; i < 30; i += 1) {
    if (fs.existsSync(file)) {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > 0) break;
    }
    await sleep(50);
  }
  assert.ok(lines.length > 0, '仿真日志文件应有内容');
  const parsed = lines.map((l) => JSON.parse(l));
  if (!parsed.some((l) => /满足计时/.test(l.message))) console.error('[DEBUG] 文件实际内容:', JSON.stringify(parsed.map((l) => l.message), null, 1));
  assert.ok(parsed.some((l) => /满足计时/.test(l.message)), '应含 hold 满足计时日志');
  assert.equal(typeof parsed[0].at, 'number', '日志应带虚拟时刻 at');

  /* 接口层：source=sim 读取同一份文件；真实版本日志不得被仿真写入 */
  const simLogs = store.readSimLogs(sid, rec.version, 100);
  assert.ok(simLogs.length === parsed.length, 'readSimLogs 行数与文件一致');
  assert.deepEqual(store.readLogs(sid, rec.version, 100), [], '仿真不写版本日志 v<n>.log');

  await executor.switchVerifyMode(sid, 'follow');
  executor.stop(sid, 'test-cleanup', rec.version);
});

/* 崩溃用例的脚本：只在 seed 的 crash=true 时抛错，否则常驻。
 * 这样第二次进入仿真可以验证「陈旧现场已清除」而不会立刻再崩一次。 */
const CRASH_SCRIPT = `
  ctx.actions({ boom: async () => {} });
  const crash = await ctx.global.get('crash', true);
  await ctx.write('boom', '崩溃前写一次', 'n_boom', 1);
  if (crash) throw new Error('模拟崩溃');
  await ctx.keepAlive();
`;

test('仿真崩溃：脚本异常终止后保留只读快照，重新进入仿真时清掉陈旧现场', async () => {
  const sid = 'sim-e2e-crash';
  const rec = store.submit(sid, {
    name: '仿真崩溃', script: CRASH_SCRIPT, flow: FLOW, channel: 'shadow', kind: 'automation',
  });

  await executor.switchVerifyMode(sid, 'simulate', {
    startAt: '2026-11-26T20:29:55+08:00',
    seed: { entities: { 'sensor.power': { state: '950', attributes: {} } }, context: { global: { crash: true } } },
  });

  /* 等脚本异常 → done:false → 主进程 kill。轮询到崩溃快照可读为止。 */
  let crash = null;
  for (let i = 0; i < 60; i += 1) {
    crash = store.readSimCrash(sid, rec.version);
    if (crash) break;
    await sleep(50);
  }
  assert.ok(crash, '崩溃现场应落盘');
  assert.equal(crash.crashed, true);
  assert.equal(crash.readOnly, true);
  assert.equal(crash.crashReason, 'script-error');
  assert.ok(crash.writes.some((w) => w.op === 'boom'), '崩溃前写意图应保留：' + JSON.stringify(crash.writes));
  assert.match(JSON.stringify(crash.execution), /模拟崩溃/);

  /* 实例已经没了，但 sim_snapshot 仍要能只读拿到现场 */
  const snap = await executor.simSnapshot(sid, {});
  assert.equal(snap.crashed, true);
  assert.equal(snap.readOnly, true);
  assert.equal(snap.fromCrashFile, true);
  assert.ok(snap.writes.some((w) => w.op === 'boom'));
  /* 只读：不能再推进 */
  await assert.rejects(() => executor.simAdvance(sid, 1000), /没有仿真/);

  /* 重新进入仿真（不崩）→ 陈旧现场清除，快照回到实时口径 */
  await executor.switchVerifyMode(sid, 'simulate', {
    force: true, seed: { entities: {}, context: { global: { crash: false } } },
  });
  await waitSnapshot(sid);
  assert.equal(store.readSimCrash(sid, rec.version), null, '新会话开始就应清掉旧崩溃现场');
  const live = await executor.simSnapshot(sid, {});
  assert.ok(!live.crashed);
  assert.ok(live.execution.runCount >= 1);

  await executor.switchVerifyMode(sid, 'follow');
  executor.stop(sid, 'test-cleanup', rec.version);
});

/* 回归：simulate 下沙箱 Date 必须指向虚拟时钟，且桥接不能丢 this。
 * 之前 sandbox.Date = makeVDate(conv(clk.now)) 把 VirtualClock.now 裸调用，
 * 脚本一碰 Date.now()/new Date() 就抛 "Cannot read properties of undefined (reading 'startEpoch')"
 * ——audr76je（用 Date.now() 做写冷却、new Date() 算窗口）首次进仿真就崩在这。 */
test('E2E：simulate 下 Date.now()/new Date() 走虚拟时钟（桥接不丢 this）', async () => {
  const sid = 'date-bridge';
  const startAt = '2026-11-26T20:29:55+08:00';
  const base = Date.parse(startAt);
  const script = `
    ctx.actions({ tick: async () => {} });
    await ctx.write('tick', '起点时刻', 'n_t0', Date.now());
    await ctx.write('tick', '起点日期', 'n_t0b', new Date().toISOString());
    ctx.after(1000, async () => {
      await ctx.write('tick', '+1s 时刻', 'n_t1', Date.now());
    });
    await ctx.keepAlive();
  `;
  const rec = store.submit(sid, { name: sid, script, flow: FLOW, channel: 'shadow', kind: 'automation' });
  await executor.switchVerifyMode(sid, 'simulate', { startAt, seed: { entities: {} } });
  await waitSnapshot(sid);

  await executor.simAdvance(sid, 1000);
  const snap = await executor.simSnapshot(sid, { include: ['writes', 'logs'] });
  const errs = snap.logs.filter((l) => l.level === 'error');
  assert.equal(errs.length, 0, '不应有脚本异常：' + JSON.stringify(errs));

  const ticks = snap.writes.filter((w) => w.op === 'tick');
  assert.equal(ticks[0].args[0], base, 'Date.now() 应等于虚拟起点');
  assert.equal(ticks[1].args[0], new Date(base).toISOString(), 'new Date() 应反映虚拟起点');
  assert.equal(ticks[2].at, 1000);
  assert.equal(ticks[2].args[0], base + 1000, '快进 1s 后 Date.now() 应同步 +1000');

  await executor.switchVerifyMode(sid, 'follow');
  executor.stop(sid, 'test-cleanup', rec.version);
});
