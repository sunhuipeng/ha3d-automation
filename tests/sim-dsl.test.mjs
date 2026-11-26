'use strict';
/* P2：断言 DSL（路径 + 算子 + 组合）、时间旅行（mark/rewind）、用例导出（tape/种子）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSimSession } = require('../server/sim/session.js');

function make() {
  return createSimSession({
    scriptId: 'dsl',
    startAt: '2026-11-26T20:29:55+08:00',
    seed: {
      entities: {
        'sensor.power': { state: '950', attributes: {} },
        'water_heater.x': { state: 'off', friendly_name: '热水器' },
      },
      context: { global: { avoiding: false } },
    },
  });
}

test('DSL：writes 路径 + 比较/正则算子', () => {
  const s = make();
  s.recordWrite({ kind: 'write', op: 'heatOn', nodeId: 'n_heat', args: [73800] });
  const r = s.assertNow({
    expect: [
      { path: 'writes.length', eq: 1 },
      { path: 'writes[0].op', eq: 'heatOn' },
      { path: 'writes[0].args[0]', gte: 73800 },
      { path: 'writes[0].nodeId', match: '^n_' },
      { path: 'writes[0].kind', ne: 'context' },
    ],
  }, {});
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.equal(r.checks[0].kind, 'expect');
  assert.deepEqual(r.checks[0].actual.map((x) => x.path), ['writes.length', 'writes[0].op', 'writes[0].args[0]', 'writes[0].nodeId', 'writes[0].kind']);
});

test('DSL：增量基准与 run_steps 的 assert 共用游标', async () => {
  const s = make();
  s.recordWrite({ kind: 'write', op: 'a' });
  const first = s.assertNow({ expect: { path: 'writes.length', eq: 1 } }, {});
  assert.equal(first.ok, true);
  /* 游标已推进：没有新增写意图时，同一断言应为 0 条 */
  const second = s.assertNow({ expect: { path: 'writes.length', eq: 0 } }, {});
  assert.equal(second.ok, true, JSON.stringify(second.checks));
  /* since 可覆盖游标，回看全量 */
  const full = s.assertNow({ expect: { path: 'writes.length', eq: 1 } }, { since: 0 });
  assert.equal(full.ok, true);
});

test('DSL：context / entities / at / clockNow 路径与类型算子', async () => {
  const s = make();
  s.inject({ context: { scope: 'global', key: 'heated', value: true } });
  await s.advance(1500);
  const r = s.assertNow({
    expect: [
      { path: 'context.global.heated', eq: true },
      { path: 'context.global["waterHeater.avoiding"]', exists: false },
      { path: 'entities["sensor.power"].state', eq: '950' },
      { path: 'entities["water_heater.x"].friendly_name', eq: '热水器' },
      { path: 'at', gte: 1500 },
      { path: 'clockNow', type: 'string' },
      { path: 'entities', type: 'object' },
    ],
  }, {});
  assert.equal(r.ok, true, JSON.stringify(r.checks));

  const bad = s.assertNow({ expect: { path: 'entities["sensor.power"].state', eq: '1200' } }, {});
  assert.equal(bad.ok, false);
  assert.match(bad.failed[0].message, /应为 "1200"/);
  assert.deepEqual(bad.failed[0].actual[0].actual, '950');
});

test('DSL：all / any / not 组合与 includes', () => {
  const s = make();
  s.recordWrite({ kind: 'write', op: 'heatOn' });
  s.recordLog({ level: 'info', message: '到点加热' });
  const ok = s.assertNow({
    expect: {
      all: [
        { any: [{ path: 'writes[0].op', eq: 'heatOn' }, { path: 'writes[0].op', eq: 'other' }] },
        { not: { path: 'writes[0].op', eq: 'markPending' } },
        { path: 'logs', includes: { seq: 2, at: 0, level: 'info', message: '到点加热' } },
      ],
    },
  }, {});
  assert.equal(ok.ok, true, JSON.stringify(ok.checks));

  const bad = s.assertNow({ expect: { any: [{ path: 'writes.length', eq: 9 }, { path: 'logs.length', eq: 9 }] } }, {});
  assert.equal(bad.ok, false);
  assert.match(bad.failed[0].message, /any 无一满足/);
});

test('DSL：未知算子报错（不静默通过）', () => {
  const s = make();
  assert.throws(() => s.assertNow({ expect: { path: 'writes.length', foo: 1 } }, {}), /未知算子：foo/);
});

test('时间旅行：rewind 只回滚世界数据，时钟不回退', async () => {
  const s = make();
  s.mark('before');
  s.inject({ entity: { entityId: 'sensor.power', state: '1200' } });
  s.inject({ context: { scope: 'global', key: 'avoiding', value: true } });
  await s.advance(1000);
  assert.equal(s.snapshot({}).at, 1000);

  const w = s.rewind('before');
  assert.equal(w.at, 0);
  assert.equal(w.clockAt, 1000, '时钟不回退');
  const snap = s.snapshot({ entityScope: 'all' });
  assert.equal(snap.entities['sensor.power'].state, '950', '实体回到标记点');
  assert.equal(snap.context.global.avoiding, false, '上下文回到标记点');
  assert.equal(snap.at, 1000);
  assert.ok(snap.logs.some((l) => /回滚/.test(l.message)), '回滚应留一条日志');

  assert.throws(() => s.rewind('nope'), /没有这个标记/);
});

test('用例导出：tape 记录驱动流水，seed 是初始种子（未被脚本污染）', async () => {
  const s = make();
  await s.advance(100);
  s.inject({ entity: { entityId: 'sensor.power', state: '1200' } });
  await s.advance(2900);
  s.recordWrite({ kind: 'write', op: 'setFlag', nodeId: 'n_write', args: [true] });

  const fx = s.exportCase();
  assert.equal(fx.startAt, '2026-11-26T12:29:55.000Z');
  assert.deepEqual(fx.steps, [
    { op: 'advance', ms: 100 },
    { op: 'inject_entity', entityId: 'sensor.power', state: '1200' },
    { op: 'advance', ms: 2900 },
  ]);
  assert.equal(fx.seed.entities['sensor.power'].state, '950', '初始种子必须是导出时的起点，不是当前终值');
  assert.equal(fx.seed.context.global.avoiding, false);
  assert.deepEqual(fx.expected.writes, [{ kind: 'write', op: 'setFlag', nodeId: 'n_write', args: [true], desc: '' }]);
});

test('runSteps：mark / rewind step 与 expect 断言可直接写在用例里', async () => {
  const s = make();
  const r = await s.runSteps([
    { op: 'mark', name: 'm1' },
    { op: 'inject_entity', entityId: 'sensor.power', state: '1200' },
    { op: 'assert', label: '注入生效', expect: { path: 'entities["sensor.power"].state', eq: '1200' } },
    { op: 'rewind', mark: 'm1' },
    { op: 'assert', label: '回滚生效', expect: { path: 'entities["sensor.power"].state', eq: '950' } },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(r.total, 2);
  assert.equal(r.results[0].mark.mark, 'm1');
  assert.equal(r.results[3].rewind.mark, 'm1');
});
