'use strict';
/* sim_run_steps 批量执行器单元测试（纯进程内）：8 类 step、增量断言、失败收集、
 * failFast、执行异常中断。用虚拟时钟预约回调模拟脚本在虚拟时刻记写意图/日志。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSimSession } = require('../server/sim/session.js');

function makeSession() {
  const dispatched = [];
  const controls = [];
  const session = createSimSession({
    scriptId: 'demo',
    startAt: '2026-11-26T20:29:55+08:00',
    seed: {
      entities: { 'sensor.power': { state: '950', attributes: {} } },
      context: { global: { avoiding: false } },
    },
    dispatch: (m) => dispatched.push(m),
    onControlLog: (m) => controls.push(m),
  });
  return { session, dispatched, controls };
}

test('runSteps：writes 断言按 seq 游标分段（自上次 assert 以来的新增）', async () => {
  const { session } = makeSession();
  session.clock.setTimeout(() => session.recordWrite({ kind: 'write', op: 'a', nodeId: 'n1', args: [1] }), 1000);
  session.clock.setTimeout(() => session.recordWrite({ kind: 'context', op: 'contextSet', args: ['avoiding', true] }), 3000);
  const r = await session.runSteps([
    { op: 'advance', ms: 1000 },
    { op: 'assert', label: 'first', writes: [{ op: 'a', nodeId: 'n1', args: [1] }] },
    { op: 'advance', ms: 2000 },
    { op: 'assert', label: 'second', writes: [{ kind: 'context', op: 'contextSet' }] },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.total, 2);
  assert.equal(r.passed, 2);
  assert.equal(r.failed, 0);
  assert.equal(r.executed, 4);
  assert.equal(r.aborted, false);
  assert.equal(r.results[1].label, 'first');
  assert.equal(r.results[1].checks[0].kind, 'writes');
  assert.equal(r.final.at, 3000);
});

test('runSteps：writes 部分匹配失败时给出实际序列（kind/op/args 差异）', async () => {
  const { session } = makeSession();
  session.clock.setTimeout(() => session.recordWrite({ kind: 'write', op: 'setFlag', nodeId: 'n_write', args: [true] }), 10);
  const r = await session.runSteps([
    { op: 'advance', ms: 10 },
    { op: 'assert', writes: [{ op: 'setFlag', nodeId: 'n_write', args: [false] }] },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.failed, 1);
  const chk = r.results[1].checks[0];
  assert.equal(chk.pass, false);
  assert.equal(chk.actual[0].op, 'setFlag');
  assert.match(chk.message, /序列不符|不符/);
});

test('runSteps：noWrites 支持 true（全部）与 op 列表（禁止指定）', async () => {
  const { session } = makeSession();
  const empty = await session.runSteps([
    { op: 'advance', ms: 50 },
    { op: 'assert', noWrites: true },
  ]);
  assert.equal(empty.ok, true);

  session.clock.setTimeout(() => session.recordWrite({ kind: 'write', op: 'allowedOp', args: [] }), 10);
  session.clock.setTimeout(() => session.recordWrite({ kind: 'write', op: 'bannedOp', args: [] }), 20);
  const r = await session.runSteps([
    { op: 'advance', ms: 20 },
    { op: 'assert', label: 'ban-banned', noWrites: ['bannedOp'] },
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.results[1].checks[0].actual, ['bannedOp']);
});

test('runSteps：state / context / logs 断言与 8 类 step 全覆盖', async () => {
  const { session, dispatched, controls } = makeSession();
  session.clock.setTimeout(() => session.recordLog({ level: 'info', message: '确认满足（持续 3000ms）', nodeId: 'n_hold' }), 500);
  const r = await session.runSteps([
    { op: 'inject_entity', entityId: 'sensor.power', state: '1200' },
    { op: 'inject_context', scope: 'global', key: 'avoiding', value: true },
    { op: 'inject_task', scriptId: 'other', state: 'running' },
    { op: 'inject_suspend', suspend: true },
    { op: 'inject_suspend', suspend: false },
    { op: 'inject_params', params: { foo: 1 } },
    { op: 'advance', ms: 500 },
    {
      op: 'assert',
      label: 'world',
      state: [{ entityId: 'sensor.power', state: '1200' }],
      context: [{ scope: 'global', key: 'avoiding', value: true }],
      logs: ['确认满足'],
    },
    { op: 'snapshot', include: ['clockNow', 'seq'] },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(r.total, 1);
  assert.ok(dispatched.some((m) => m.type === 'state' && m.state.state === '1200'));
  assert.ok(dispatched.some((m) => m.type === 'contextChange' && m.key === 'avoiding'));
  assert.ok(dispatched.some((m) => m.type === 'taskState' && m.state === 'running'));
  assert.deepEqual(dispatched.filter((m) => m.type === 'suspend' || m.type === 'resume').map((m) => m.type), ['suspend', 'resume']);
  assert.ok(controls.some((m) => /params/.test(m.message)));
  assert.equal(r.results[8].snapshot.at, 500);
});

test('runSteps：断言失败默认不中断，收集全部失败点', async () => {
  const { session } = makeSession();
  const r = await session.runSteps([
    { op: 'assert', label: 'bad1', writes: [{ op: 'ghost' }] },
    { op: 'assert', label: 'ok', noWrites: true },
    { op: 'assert', label: 'bad2', state: [{ entityId: 'missing', state: 'x' }] },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.executed, 3);
  assert.equal(r.total, 3);
  assert.equal(r.failed, 2);
  assert.equal(r.passed, 1);
  assert.equal(r.aborted, false);
  assert.deepEqual(r.results.filter((x) => x.op === 'assert' && !x.passed).map((x) => x.label), ['bad1', 'bad2']);
});

test('runSteps：failFast 在首个失败断言处停止', async () => {
  const { session } = makeSession();
  const r = await session.runSteps([
    { op: 'assert', label: 'bad', writes: [{ op: 'ghost' }] },
    { op: 'assert', label: 'never', noWrites: true },
  ], { failFast: true });
  assert.equal(r.ok, false);
  assert.equal(r.executed, 1);
  assert.equal(r.results.length, 1);
  assert.equal(r.aborted, false);
});

test('runSteps：非法 op 抛错中断，aborted=true，保留已完成步骤', async () => {
  const { session } = makeSession();
  const r = await session.runSteps([
    { op: 'assert', writes: [] },
    { op: 'bogus' },
    { op: 'assert', writes: [] },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.aborted, true);
  assert.equal(r.executed, 2, '失败的那步也是"跑过"的，计入 executed');
  assert.equal(r.results.length, 2);
  assert.match(r.results[1].error, /未知的 step op/);
});

test('runSteps：assert 支持 since 覆盖增量基准（since:0 = 全序列）', async () => {
  const { session } = makeSession();
  session.clock.setTimeout(() => session.recordWrite({ kind: 'write', op: 'a', nodeId: 'n1', args: [1] }), 1000);
  session.clock.setTimeout(() => session.recordWrite({ kind: 'write', op: 'b', nodeId: 'n2', args: [2] }), 3000);
  const r = await session.runSteps([
    { op: 'advance', ms: 1000 },
    { op: 'assert', label: 'first', writes: [{ op: 'a', nodeId: 'n1', args: [1] }] },
    { op: 'advance', ms: 2000 },
    /* 自带 assert 消耗了游标，since:0 仍能看到全部两条（sim_run_fixture 追尾断言走这条路） */
    { op: 'assert', label: 'full', since: 0, writes: [{ op: 'a', nodeId: 'n1', args: [1] }, { op: 'b', nodeId: 'n2', args: [2] }] },
    /* 后续断言不受 since 影响，游标仍在"全序列断言消耗点"上 */
    { op: 'assert', label: 'after', noWrites: true },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(r.total, 3);
  assert.equal(r.passed, 3);
});
