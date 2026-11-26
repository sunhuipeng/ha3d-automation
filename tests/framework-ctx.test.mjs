'use strict';
/* 框架层 ctx 能力测试：真实 fork runner，mock 主进程回 IPC。
 * 覆盖 ctx.actions/ctx.write（影子拦截 / 正式下发 / 未注册报错）、ctx.lock 防重入、
 * ctx.num / ctx.ha.num / ctx.time。全程不连接真实 HA。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, '../server/scripts/runner.js');

const STATES = {
  'sensor.test': { state: '42.5', attributes: { temperature: 65 } },
};

function runScript(script, { dryRun = true, meta = {} } = {}) {
  return new Promise((resolve) => {
    const child = fork(RUNNER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, HA3D_RUNNER: '1' } });
    const logs = [];
    const calls = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (e) {}
      resolve({ logs, calls, text: logs.map((l) => l.message).join('\n') });
    };
    child.on('message', (msg) => {
      if (msg.type === 'request') {
        const { id, action, data } = msg;
        if (action === 'getState') return child.send({ type: 'reply', id, ok: true, result: STATES[data.entityId] || null });
        if (action === 'callService') { calls.push(data); return child.send({ type: 'reply', id, ok: true, result: {} }); }
        return child.send({ type: 'reply', id, ok: true, result: null });
      }
      if (msg.type === 'log') logs.push(msg);
      if (msg.type === 'done') finish();
    });
    child.send({ type: 'run', script, meta: { version: 1, dryRun, ...meta } });
    setTimeout(finish, 6000);
  });
}

test('ctx.write：未注册的动作直接报错，不会静默下发', async () => {
  const { text, calls } = await runScript(`
    try { await ctx.write('nope', '未注册动作'); ctx.log('info', 'NO_THROW'); }
    catch (e) { ctx.log('info', 'ERR:' + e.message); }
  `);
  assert.match(text, /ERR:未注册的动作/);
  assert.equal(calls.length, 0);
});

test('ctx.write：影子模式下拦截，返回 false 且不调用动作', async () => {
  const { text, calls } = await runScript(`
    ctx.actions({ a: () => ctx.ha.callService('water_heater', 'turn_on', { entity_id: 'wh' }) });
    const ok = await ctx.write('a', '测试写操作', 'n1');
    ctx.log('info', 'RET:' + ok);
    ctx.log('info', 'STATS:' + JSON.stringify(ctx.stats()));
  `, { dryRun: true });
  assert.equal(calls.length, 0, '影子模式不应产生真实 callService');
  assert.match(text, /RET:false/);
  assert.match(text, /\[影子·拦截写操作\] 测试写操作（action\.a，未下发）/);
  assert.match(text, /"intent":1,"sent":0,"blocked":1/);
});

test('ctx.write：正式模式下真实下发并透传参数', async () => {
  const { text, calls } = await runScript(`
    ctx.actions({ t: (v) => ctx.ha.callService('water_heater', 'set_temperature', { entity_id: 'wh', temperature: v }) });
    const ok = await ctx.write('t', '设目标温度', 'n1', 65);
    ctx.log('info', 'RET:' + ok);
  `, { dryRun: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].service, 'set_temperature');
  assert.equal(calls[0].data.temperature, 65);
  assert.match(text, /RET:true/);
  assert.match(text, /\[真实写操作\] 设目标温度（action\.t）/);
});

test('ctx.lock：同 key 并发时只执行一次，第二次返回 false', async () => {
  const { text } = await runScript(`
    let hits = 0;
    const slow = () => ctx.lock(async () => { hits++; await ctx.sleep(120); });
    const r = await Promise.all([slow(), slow()]);
    ctx.log('info', 'LOCK:' + JSON.stringify(r) + ' hits=' + hits);
  `);
  assert.match(text, /LOCK:\[true,false\] hits=1/);
});

test('ctx.lock：不同 key 互不阻塞', async () => {
  const { text } = await runScript(`
    const r = await Promise.all([
      ctx.lock('a', async () => { await ctx.sleep(80); }),
      ctx.lock('b', async () => { await ctx.sleep(80); }),
    ]);
    ctx.log('info', 'KEYS:' + JSON.stringify(r));
  `);
  assert.match(text, /KEYS:\[true,true\]/);
});

test('ctx.num / ctx.ha.num / ctx.time 语义', async () => {
  const { text } = await runScript(`
    ctx.log('info', 'NUM:' + ctx.num('3.5') + ',' + ctx.num('abc') + ',' + ctx.num(null));
    ctx.log('info', 'HS:' + (await ctx.ha.num('sensor.test')) + ',' + (await ctx.ha.num('sensor.missing', null)));
    ctx.log('info', 'TIME:' + ctx.time.formatSod(73800) + ',' + ctx.time.formatSod(0));
    ctx.log('info', 'ST:' + (await ctx.ha.state('sensor.test')) + ',' + (await ctx.ha.state('sensor.missing')));
  `);
  assert.match(text, /NUM:3\.5,0,0/);
  assert.match(text, /HS:42\.5,null/);
  assert.match(text, /TIME:20:30:00,00:00:00/);
  assert.match(text, /ST:42\.5,null/);
});

test('ctx.actions：重复注册与非法值都要报错', async () => {
  const { text } = await runScript(`
    ctx.actions({ a: () => {} });
    try { ctx.actions({ a: () => {} }); } catch (e) { ctx.log('info', 'DUP:' + e.message); }
    try { ctx.actions({ b: 1 }); } catch (e) { ctx.log('info', 'BAD:' + e.message); }
  `);
  assert.match(text, /DUP:动作重复注册：a/);
  assert.match(text, /BAD:ctx\.actions\.b 必须是函数/);
});

test('ctx.ha.getAttribute：读实体属性，缺属性/缺实体回退', async () => {
  const { text } = await runScript(`
    const hvac = await ctx.ha.getAttribute('sensor.test', 'temperature');
    const miss = await ctx.ha.getAttribute('sensor.test', 'nope', 'DEF');
    const noent = await ctx.ha.getAttribute('sensor.missing', 'temperature', 'X');
    ctx.log('info', 'ATTR:' + hvac + ',' + miss + ',' + noent);
  `);
  assert.match(text, /ATTR:65,DEF,X/);
});

test('ctx.time.weekday / nowISO 可用', async () => {
  const { text } = await runScript(`
    ctx.log('info', 'WD:' + ctx.time.weekday() + ' ISO:' + ctx.time.nowISO().slice(0,4));
  `);
  assert.match(text, /WD:(sun|mon|tue|wed|thu|fri|sat) ISO:\d{4}/);
});

test('ctx.after / ctx.cancel：可取消延时（mode:restart 语义）', async () => {
  const { text } = await runScript(`
    let hits = 0;
    const id = ctx.after(40, () => { hits++; });
    ctx.cancel(id);
    ctx.after(40, () => { hits++; ctx.log('info', 'HITS:' + hits); });
    await ctx.sleep(120);
  `);
  assert.match(text, /HITS:1/, '被取消的定时器不应触发');
});

test('ctx.every / ctx.cancel：周期定时触发与取消，stop 后静默', async () => {
  const { text } = await runScript(`
    let ticks = 0;
    const id = ctx.every(30, () => { ticks++; });
    await ctx.sleep(100);          // ~3 次触发
    ctx.cancel(id);
    const after = ticks;
    await ctx.sleep(80);           // 取消后不应再涨
    ctx.log('info', 'TICKS:' + after + ':' + ticks);
  `);
  const m = text.match(/TICKS:(\d+):(\d+)/);
  assert.ok(m, '应输出 TICKS');
  assert.ok(Number(m[1]) >= 2, '周期内应至少触发 2 次');
  assert.equal(Number(m[2]), Number(m[1]), 'cancel 后不应再触发');
});
