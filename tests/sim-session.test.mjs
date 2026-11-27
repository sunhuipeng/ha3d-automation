'use strict';
/* 仿真会话/宿主桥测试（纯进程内）：request 应答、注入派发、写意图、快照增量。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSimSession } = require('../server/sim/session.js');

function makeSession(opts = {}) {
  const dispatched = [];
  const logs = [];
  const session = createSimSession({
    scriptId: 'demo',
    startAt: '2026-11-26T20:29:55+08:00',
    seed: {
      entities: {
        'sensor.power': { state: '950', attributes: {} },
        'water_heater.x': { state: 'off', attributes: {}, friendly_name: '热水器' },
      },
      context: { global: { 'waterHeater.avoiding': false } },
    },
    dispatch: (m) => dispatched.push(m),
    onControlLog: (m) => logs.push(m),
    ...opts,
  });
  return { session, dispatched, logs };
}

test('仿真宿主：getState/listEntities 读虚拟表，缺失返回 null', () => {
  const { session } = makeSession();
  assert.deepEqual(session.request({ id: 1, action: 'getState', data: { entityId: 'sensor.power' } }).result, { state: '950', attributes: {} });
  assert.equal(session.request({ id: 2, action: 'getState', data: { entityId: 'nope' } }).result, null);
  const list = session.request({ id: 3, action: 'listEntities', data: { filter: '热水' } }).result;
  assert.equal(list.length, 1);
  assert.equal(list[0].entityId, 'water_heater.x');
});

test('仿真宿主：contextGet/Set 走会话虚拟桶，不落盘', () => {
  const { session, dispatched } = makeSession();
  assert.equal(session.request({ id: 1, action: 'contextGet', data: { scope: 'global', key: 'waterHeater.avoiding' } }).result, false);
  const r = session.request({ id: 2, action: 'contextSet', data: { scope: 'global', key: 'waterHeater.avoiding', value: true } });
  assert.equal(r.ok, true);
  assert.equal(session.request({ id: 3, action: 'contextGet', data: { scope: 'global', key: 'waterHeater.avoiding' } }).result, true);
  assert.ok(dispatched.some((m) => m.type === 'contextChange' && m.key === 'waterHeater.avoiding'));
  assert.equal(session.snapshot({}).context.global['waterHeater.avoiding'], true);
});

test('仿真宿主：callService 记写意图并回写虚拟表，不下发真实 HA', () => {
  const { session, dispatched } = makeSession();
  const r = session.request({ id: 1, action: 'callService', data: { domain: 'water_heater', service: 'turn_on', data: { entity_id: 'water_heater.x' } } });
  assert.equal(r.result.simulated, true);
  assert.equal(session.request({ id: 2, action: 'getState', data: { entityId: 'water_heater.x' } }).result.state, 'on');
  assert.ok(dispatched.some((m) => m.type === 'state' && m.entityId === 'water_heater.x'));
  const writes = session.snapshot({}).writes;
  assert.equal(writes[0].kind, 'service');
  assert.equal(writes[0].op, 'water_heater.turn_on');
});

test('仿真宿主：callScript mock / taskStatus 默认 stopped 可注入', () => {
  const { session } = makeSession();
  assert.equal(session.request({ id: 1, action: 'callScript', data: { scriptId: 'other' } }).result.mocked, true);
  assert.equal(session.request({ id: 2, action: 'taskStatus', data: { scriptId: 'other' } }).result.state, 'stopped');
  session.inject({ task: { scriptId: 'other', state: 'running' } });
  assert.equal(session.request({ id: 3, action: 'taskStatus', data: { scriptId: 'other' } }).result.state, 'running');
});

test('仿真注入：实体变化先改表再派发 state（含 prev）', () => {
  const { session, dispatched } = makeSession();
  const r = session.inject({ entity: { entityId: 'sensor.power', state: '1200' } });
  assert.equal(r.ok, true);
  const st = dispatched.find((m) => m.type === 'state');
  assert.equal(st.state.state, '1200');
  assert.equal(st.prev.state, '950');
  assert.equal(session.request({ id: 1, action: 'getState', data: { entityId: 'sensor.power' } }).result.state, '1200');
});

test('仿真快照：logs/writes 带虚拟 at 与 seq，since 增量', async () => {
  const { session } = makeSession();
  session.recordLog({ level: 'info', message: 'a', nodeId: 'n1' });
  session.recordWrite({ kind: 'write', op: 'setFlag', desc: '大功率', nodeId: 'n2', args: [true] });
  const s1 = session.snapshot({});
  assert.equal(s1.logs.length, 1);
  assert.equal(s1.writes.length, 1);
  assert.equal(s1.writes[0].op, 'setFlag');
  assert.equal(s1.seq, 2);
  await session.advance(3000);
  session.recordLog({ level: 'info', message: 'b' });
  const s2 = session.snapshot({ since: s1.seq });
  assert.equal(s2.logs.length, 1);
  assert.equal(s2.logs[0].message, 'b');
  assert.ok(s2.logs[0].at >= 3000);
});

test('仿真快照：include 裁剪字段', () => {
  const { session } = makeSession();
  const s = session.snapshot({ include: ['writes', 'entities'] });
  assert.ok(s.writes);
  assert.ok(s.entities);
  assert.equal(s.logs, undefined);
  assert.equal(s.context, undefined);
});

test('仿真快照：entities 默认只含用过的实体，entityScope:all 才全量', () => {
  const { session } = makeSession();
  /* 种子两个实体，脚本只用了一个：默认快照只该出现被读过的那个 */
  session.request({ id: 1, action: 'getState', data: { entityId: 'sensor.power' } });
  const used = session.snapshot({ include: ['entities'] });
  assert.equal(used.entityScope, 'used');
  assert.deepEqual(Object.keys(used.entities), ['sensor.power']);
  assert.equal(used.entities['sensor.power'].used, true);

  const all = session.snapshot({ include: ['entities'], entityScope: 'all' });
  assert.equal(all.entityScope, 'all');
  assert.deepEqual(Object.keys(all.entities).sort(), ['sensor.power', 'water_heater.x']);
  assert.equal(all.entities['water_heater.x'].used, false);
});

test('仿真会话：时间推进与 iso 口径正确', async () => {
  const { session } = makeSession();
  await session.advance(10);
  assert.equal(session.snapshot({}).at, 10);
  assert.match(session.snapshot({}).clockNow, /12:29:55\.010Z/);
});

test('仿真注入：suspend/resume 派发正确消息', () => {
  const { session, dispatched } = makeSession();
  session.inject({ suspend: true });
  session.inject({ suspend: false });
  const kinds = dispatched.filter((m) => m.type === 'suspend' || m.type === 'resume').map((m) => m.type);
  assert.deepEqual(kinds, ['suspend', 'resume']);
});

/* 回归：callService('toggle') 必须像真实 HA 一样翻转虚拟实体并派发 state。
 * 之前只处理 turn_on/turn_off/set_value，toggle 既不翻状态也不派发 →
 * 「长按 → 切自动开关 → watch 触发复核」这条链在仿真里断掉（s4night 吃这个亏）。 */
test('仿真宿主：toggle 翻转实体并派发 state_changed', async () => {
  const { session, dispatched } = makeSession();
  const before = dispatched.length;
  const r = await session.request({ id: 1, action: 'callService', data: { domain: 'input_boolean', service: 'toggle', data: { entity_id: 'water_heater.x' } } });
  assert.equal(r.ok, true);
  assert.equal(r.result.simulated, true);
  const states = dispatched.slice(before).filter((m) => m.type === 'state');
  assert.equal(states.length, 1, 'toggle 后必须派发一次 state');
  assert.equal(states[0].entityId, 'water_heater.x');
  assert.equal(states[0].state.state, 'on', 'off → on');
  assert.equal(states[0].prev.state, 'off');
  assert.equal(session.snapshot({ include: ['entities'], entityScope: 'all' }).entities['water_heater.x'].state, 'on');

  await session.request({ id: 2, action: 'callService', data: { domain: 'input_boolean', service: 'toggle', data: { entity_id: 'water_heater.x' } } });
  assert.equal(session.snapshot({ include: ['entities'], entityScope: 'all' }).entities['water_heater.x'].state, 'off', 'on → off');
});

/* 回归 B1：未进种子的实体 callService 必须自动建表并派发 state，否则 watch 它的
 * 分支永远等不到 state_changed（只记写意图等于静默挂死）。 */
test('仿真宿主：callService 对未知实体自动建表并派发 state', async () => {
  const { session, dispatched } = makeSession();
  const before = dispatched.length;
  const r = await session.request({ id: 1, action: 'callService', data: { domain: 'switch', service: 'turn_on', data: { entity_id: 'switch.auto_mode' } } });
  assert.equal(r.ok, true);
  const states = dispatched.slice(before).filter((m) => m.type === 'state');
  assert.equal(states.length, 1, '未知实体也要派发一次 state');
  assert.equal(states[0].entityId, 'switch.auto_mode');
  assert.equal(states[0].state.state, 'on');
  assert.equal(states[0].prev.state, null, '新建实体初始态为 null');
  const snap = session.snapshot({ include: ['entities'] });
  assert.equal(snap.entities['switch.auto_mode'].state, 'on', '自动建的实体脚本已用过，默认快照可见');

  /* toggle 在新建实体上（初始 null → on）同样成立 */
  await session.request({ id: 2, action: 'callService', data: { domain: 'switch', service: 'toggle', data: { entity_id: 'switch.fresh' } } });
  assert.equal(session.snapshot({ include: ['entities'] }).entities['switch.fresh'].state, 'on', 'null → on');
});

/* 回归 B3：mark 自动名不得静默覆盖同名手动标记。 */
test('仿真会话：mark 自动名跳过已占用的名字', () => {
  const { session } = makeSession();
  const m1 = session.mark('m1');
  assert.equal(m1.mark, 'm1');
  session.mark('m2');                 // size=2
  const auto = session.mark();        // size+1=3，但若逻辑是 m3 应正常；再造 m3 撞名场景：
  assert.equal(auto.mark, 'm3');
  const m3 = session.mark('m3');      // 手动覆盖 m3（同名重建是显式行为，允许）
  assert.equal(m3.mark, 'm3');
  const auto2 = session.mark();       // 下一个自动名必须避开 m3
  assert.equal(auto2.mark, 'm4');
});

/* 回归 B2 语义层：inject 的 params 分支可从会话层触达（MCP schema 层另有 passthrough 校验）。 */
test('仿真注入：params 只提示不生效，记入控制日志', () => {
  const { session, logs } = makeSession();
  const r = session.inject({ params: { foo: 'bar' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, [{ kind: 'params', value: { foo: 'bar' } }]);
  assert.ok(logs.some((m) => /params/.test(m.message)));
});
