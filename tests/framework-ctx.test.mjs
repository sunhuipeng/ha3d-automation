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
  'sensor.una': { state: 'unavailable' },
  'sensor.unk': { state: 'unknown' },
  'sensor.none': { state: 'none' },
  'sensor.empty': { state: '' },
  'sensor.busy': { state: 'Busy' },
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
        if (action === 'listEntities') return child.send({ type: 'reply', id, ok: true, result: data.filter ? Object.keys(STATES).filter((k) => k.includes(data.filter)) : Object.keys(STATES) });
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

test('ctx.invalid：统一判定 null/空串/unavailable/unknown/none/NaN，合法枚举不误判', async () => {
  const { text } = await runScript(`
    const inv = [null, undefined, '', '  ', 'unavailable', 'unknown', 'none', 'UNAVAILABLE', ' Unknown ', NaN];
    const ok  = ['on', 'off', 'Busy', 'Idle', '42.5', '0', 0, 42, true, false];
    ctx.log('info', 'INV:' + inv.map((v) => ctx.invalid(v)).join(','));
    ctx.log('info', 'OK:' + ok.map((v) => ctx.invalid(v)).join(','));
  `);
  assert.match(text, /INV:true,true,true,true,true,true,true,true,true,true/);
  assert.match(text, /OK:false,false,false,false,false,false,false,false,false,false/);
});

test('ctx.ha.num：状态无效也返回 fallback（null/100 真正兑现），合法非数字串也 fallback', async () => {
  const { text } = await runScript(`
    ctx.log('info', 'UNA:' + (await ctx.ha.num('sensor.una', null)) + ',' + (await ctx.ha.num('sensor.una', 100)));
    ctx.log('info', 'UNK:' + (await ctx.ha.num('sensor.unk', null)) + ',' + (await ctx.ha.num('sensor.unk', 100)));
    ctx.log('info', 'NONE:' + (await ctx.ha.num('sensor.none', 100)));
    ctx.log('info', 'EMPTY:' + (await ctx.ha.num('sensor.empty', 100)));
    ctx.log('info', 'NONNUM:' + (await ctx.ha.num('sensor.busy', 100)));
    ctx.log('info', 'VALID:' + (await ctx.ha.num('sensor.test', 100)));
    ctx.log('info', 'MISS:' + (await ctx.ha.num('sensor.missing', 100)));
  `);
  assert.match(text, /UNA:null,100/);
  assert.match(text, /UNK:null,100/);
  assert.match(text, /NONE:100/);
  assert.match(text, /EMPTY:100/);
  assert.match(text, /NONNUM:100/);
  assert.match(text, /VALID:42\.5/);
  assert.match(text, /MISS:100/);
});

test('ctx.ha.num：默认 fallback 仍为 0（旧调用零变化）；ctx.ha.state 原样返回无效字符串', async () => {
  const { text } = await runScript(`
    ctx.log('info', 'DEFAULT:' + (await ctx.ha.num('sensor.una')) + ',' + (await ctx.ha.num('sensor.busy')));
    ctx.log('info', 'STATE:' + (await ctx.ha.state('sensor.una')) + ',' + (await ctx.ha.state('sensor.busy')) + ',' + (await ctx.ha.state('sensor.missing')));
  `);
  assert.match(text, /DEFAULT:0,0/);
  assert.match(text, /STATE:unavailable,Busy,null/);
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

test('ctx.ha.entity：读完整状态对象，缺实体返回 null', async () => {
  const { text } = await runScript(`
    const s = await ctx.ha.entity('sensor.test');
    const miss = await ctx.ha.entity('sensor.missing');
    ctx.log('info', 'ENTITY:' + s.state + ',' + (miss === null));
  `);
  assert.match(text, /ENTITY:42.5,true/);
});

test('ctx.ha.listEntities：列实体，支持 filter 过滤；旧名 list 已移除', async () => {
  const { text } = await runScript(`
    const all = await ctx.ha.listEntities();
    const filtered = await ctx.ha.listEntities('unk');
    ctx.log('info', 'LIST:' + Object.keys(all).length + ',' + Object.values(filtered).join('|') + ',old=' + (typeof ctx.ha.list));
  `);
  assert.match(text, /LIST:\d+,sensor\.unk,old=undefined/);
});

test('ctx.ha.attr：读单个属性，缺属性/缺实体回退', async () => {
  const { text } = await runScript(`
    const v = await ctx.ha.attr('sensor.test', 'temperature');
    const miss = await ctx.ha.attr('sensor.test', 'nope', 'DEF');
    const noent = await ctx.ha.attr('sensor.missing', 'temperature', 'X');
    ctx.log('info', 'ATTR:' + v + ',' + miss + ',' + noent);
  `);
  assert.match(text, /ATTR:65,DEF,X/);
});

test('ctx.ha.attrs：读完整 attributes 对象，缺实体回退', async () => {
  const { text } = await runScript(`
    const all = await ctx.ha.attrs('sensor.test');
    const noent = await ctx.ha.attrs('sensor.missing', { fallback: 1 });
    ctx.log('info', 'ALL:' + JSON.stringify(all) + ' NOENT:' + JSON.stringify(noent));
  `);
  assert.match(text, /ALL:\{"temperature":65\}/);
  assert.match(text, /NOENT:\{"fallback":1\}/);
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
