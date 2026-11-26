'use strict';
/* inline（单进程）执行模式专项测试：直接用 createInlineChild 手工桥接 request，
 * 覆盖影子拦截、mode 热切换、stop 清定时器、同步死循环被 V8 timeout 中断、
 * suspend 兜底跳过写操作。全程不连接真实 HA，也不经过主进程 executor。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInlineChild } from '../server/scripts/inline-runner.js';

const STATES = {
  'sensor.test': { state: '42.5', attributes: {} },
};

function bridge(child, { states = STATES, onCall = () => {} } = {}) {
  const logs = [];
  const calls = [];
  child.on('message', (msg) => {
    if (msg.type === 'log') { logs.push(msg); return; }
    if (msg.type === 'request') {
      const { id, action, data } = msg;
      if (action === 'getState') return child.send({ type: 'reply', id, ok: true, result: states[data.entityId] || null });
      if (action === 'callService') { calls.push(data); return child.send({ type: 'reply', id, ok: true, result: {} }); }
      return child.send({ type: 'reply', id, ok: true, result: null });
    }
  });
  return { logs, calls };
}

function run(child, script, meta = {}) {
  return new Promise((resolve) => {
    child.on('message', function h(msg) {
      if (msg.type === 'done') { child.removeListener('message', h); resolve(msg); }
    });
    child.send({ type: 'run', script, meta: { version: 1, ...meta } });
  });
}

test('inline：影子模式拦截写操作，返回 false 且 0 次 callService', async () => {
  const child = createInlineChild();
  const { logs, calls } = bridge(child);
  const done = await run(child, `
    ctx.actions({ a: () => ctx.ha.callService('water_heater', 'turn_on', { entity_id: 'wh' }) });
    const ok = await ctx.write('a', '测试写', 'n1');
    ctx.log('info', 'RET:' + ok);
  `, { dryRun: true });
  assert.equal(done.ok, true);
  assert.equal(calls.length, 0);
  const text = logs.map((l) => l.message).join('\n');
  assert.match(text, /RET:false/);
  assert.match(text, /\[影子·拦截写操作\] 测试写（action\.a，未下发）/);
});

test('inline：mode 热切换到正式后真实下发', async () => {
  const child = createInlineChild();
  const { logs, calls } = bridge(child);
  const done = await new Promise((resolve) => {
    child.on('message', function h(msg) {
      if (msg.type === 'log' && /RET:true/.test(msg.message)) {
        child.removeListener('message', h);
        return resolve(null);
      }
      if (msg.type === 'done') { child.removeListener('message', h); resolve(msg); }
    });
    child.send({ type: 'run', script: `
      ctx.actions({ a: () => ctx.ha.callService('water_heater', 'turn_on', { entity_id: 'wh' }) });
      await ctx.sleep(600); // 等主测在 300ms 时热切换到正式模式
      ctx.log('info', 'RET:' + await ctx.write('a', '热切换测试', 'n1'));
    `, meta: { version: 1, dryRun: true } });
    setTimeout(() => { child.send({ type: 'mode', dryRun: false }); }, 300);
  });
  assert.equal(done, null, '应在正式模式下看到 RET:true');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].service, 'turn_on');
  assert.match(logs.map((l) => l.message).join('\n'), /运行模式切换：正式模式/);
});

test('inline：stop/kill 后循环定时器不再触发', async () => {
  const child = createInlineChild();
  const { logs } = bridge(child);
  child.send({ type: 'run', script: `setInterval(() => ctx.log('info', 'tick'), 100);`, meta: { version: 1, dryRun: true } });
  await new Promise((r) => setTimeout(r, 350));
  const before = logs.filter((l) => l.message === 'tick').length;
  assert.ok(before >= 2, '停止前应有多次 tick，实际 ' + before);
  child.kill();
  await new Promise((r) => setTimeout(r, 400));
  const after = logs.filter((l) => l.message === 'tick').length;
  assert.equal(after, before, 'kill 后不应再有 tick');
});

test('inline：订阅回调同步死循环被 V8 timeout 中断，宿主不卡死', async () => {
  const child = createInlineChild();
  const { logs } = bridge(child);
  await run(child, `
    ctx.ha.onStateChange('sensor.test', () => { const t = Date.now(); while (Date.now() - t < 60000) {} });
    ctx.log('info', 'READY');
  `, { dryRun: true, cbTimeoutMs: 100 });
  child.send({ type: 'state', entityId: 'sensor.test', state: STATES['sensor.test'], prev: null });
  // 若没有 timeout 保护，这一步会卡住整个测试进程
  const t0 = Date.now();
  child.send({ type: 'state', entityId: 'sensor.test', state: STATES['sensor.test'], prev: null });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1500, '回调被 timeout 中断后应很快返回，实际 ' + elapsed + 'ms');
  const text = logs.map((l) => l.message).join('\n');
  assert.match(text, /回调执行被中断（同步超时\/异常）/);
});

test('inline：suspend 后 ctx.write 跳过动作（兜底闸）', async () => {
  const child = createInlineChild();
  const { logs, calls } = bridge(child);
  const done = await new Promise((resolve) => {
    child.on('message', function h(msg) {
      if (msg.type === 'log' && /RET:false/.test(msg.message)) { child.removeListener('message', h); return resolve(null); }
      if (msg.type === 'done') { child.removeListener('message', h); resolve(msg); }
    });
    child.send({ type: 'run', script: `
      ctx.actions({ a: () => ctx.ha.callService('water_heater', 'turn_on', { entity_id: 'wh' }) });
      await ctx.sleep(600); // 等主测在 200ms 时下发 suspend
      ctx.log('info', 'RET:' + await ctx.write('a', '挂起期间写', 'n1'));
    `, meta: { version: 1, dryRun: false } });
    setTimeout(() => { child.send({ type: 'suspend', reason: 'ha-offline' }); }, 200);
  });
  assert.equal(done, null, '应看到 RET:false 而不是真实下发');
  assert.equal(calls.length, 0);
  assert.match(logs.map((l) => l.message).join('\n'), /\[兜底\] 动作已跳过（ha-offline）：挂起期间写/);
});

test('inline：S2 realm 加固仍生效——脚本拿不到宿主 process', async () => {
  const child = createInlineChild();
  const { logs } = bridge(child);
  const done = await run(child, `
    let leaked = 'NO';
    try { leaked = typeof process !== 'undefined' ? 'LEAK' : 'NO'; } catch (e) { leaked = 'THROW'; }
    ctx.log('info', 'LEAK:' + leaked);
  `, { dryRun: true });
  assert.equal(done.ok, true);
  assert.match(logs.map((l) => l.message).join('\n'), /LEAK:(NO|THROW)/);
  assert.doesNotMatch(logs.map((l) => l.message).join('\n'), /LEAK:LEAK/);
});
