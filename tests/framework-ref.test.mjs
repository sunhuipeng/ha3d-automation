'use strict';
/* ctx.ref 专项测试（2026-11-28）：
 * ① 初始值读取；相同值赋值静默吞掉（对象按 JSON 结构比较）。
 * ② 值变化触发 watch：回调签名 (v, prev, info)，info.source='set'。
 * ③ 注册默认不立即通知；opts.immediate=true 显式回放（prev=null、source='replay'）。
 * ④ off() 后不再收到通知。
 * ⑤ 多个 watcher 都收到、按注册顺序。
 * 复用 mock 宿主模式（fork runner.js，不连接真实 HA，ref 纯闭包内存无宿主交互）。 */
import { fork } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, '../server/scripts/runner.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runWithMockHost(script, { meta = {} } = {}) {
  return new Promise((resolve) => {
    const child = fork(RUNNER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, HA3D_RUNNER: '1' } });
    const logs = [];
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch (e) {}
      resolve({ text: logs.map((l) => l.message).join('\n') });
    };
    child.on('message', (msg) => {
      if (msg.type === 'log') logs.push(msg);
      if (msg.type === 'request') child.send({ type: 'reply', id: msg.id, ok: true, result: null });
      if (msg.type === 'done') finish();
    });
    timer = setTimeout(finish, 5000);
    child.send({ type: 'run', script, meta: { version: 1, dryRun: true, sid: 'self', ...meta } });
  });
}

test('ref：初始值可读；相同值赋值静默吞掉（对象按 JSON 结构比较）', async () => {
  const { text } = await runWithMockHost(`
    const a = ctx.ref(1);
    ctx.log('info', 'INIT:' + a.value);
    a.watch((v) => ctx.log('info', 'W:' + JSON.stringify(v)));
    a.value = 1;                 // 标量相同 → 不触发
    a.value = { x: 1 };          // 类型不同 → 触发
    a.value = { x: 1 };          // 结构相同的新对象 → 不触发（JSON 结构比较）
    a.value = { x: 2 };          // 结构不同 → 触发
    await ctx.sleep(80);
  `);
  assert.match(text, /INIT:1/, '初始值可读');
  const fires = [...text.matchAll(/W:(\{[^}]*\})/g)].map((m) => m[1]);
  assert.deepEqual(fires, ['{"x":1}', '{"x":2}'], '只有两次真正变化触发');
});

test('ref：值变化触发 watch，回调签名 (v, prev, info.source=set)', async () => {
  const { text } = await runWithMockHost(`
    const a = ctx.ref('off');
    a.watch((v, prev, info) => ctx.log('info', 'W:' + v + ':' + prev + ':' + (info.source || 'set')));
    a.value = 'on';
    await ctx.sleep(80);
  `);
  assert.match(text, /W:on:off:set/, 'value、prev、info.source 均正确');
});

test('ref：默认注册不立即通知；immediate=true 显式回放（prev=null、source=replay）', async () => {
  const { text } = await runWithMockHost(`
    const a = ctx.ref('init');
    a.watch(() => ctx.log('info', 'NO_REPLAY'));
    a.watch((v, prev, info) => ctx.log('info', 'YES:' + v + ':' + prev + ':' + (info.source || 'set')), { immediate: true });
    await ctx.sleep(80);
  `);
  assert.doesNotMatch(text, /NO_REPLAY/, '默认注册不触发');
  assert.match(text, /YES:init:null:replay/, 'immediate=true 注册即回放当前值');
});

test('ref：off() 后不再收到通知', async () => {
  const { text } = await runWithMockHost(`
    const a = ctx.ref(0);
    const off = a.watch((v) => ctx.log('info', 'W:' + v));
    a.value = 1;
    off();
    a.value = 2;
    await ctx.sleep(80);
  `);
  assert.match(text, /W:1/, 'off 前的变化正常收到');
  assert.doesNotMatch(text, /W:2/, 'off 后的变化不再收到');
});

test('ref：多个 watcher 都收到、按注册顺序', async () => {
  const { text } = await runWithMockHost(`
    const a = ctx.ref(0);
    a.watch(() => ctx.log('info', 'FIRST'));
    a.watch(() => ctx.log('info', 'SECOND'));
    a.value = 1;
    await ctx.sleep(80);
  `);
  const i1 = text.indexOf('FIRST');
  const i2 = text.indexOf('SECOND');
  assert.ok(i1 >= 0 && i2 >= 0, '两个 watcher 都触发');
  assert.ok(i1 < i2, '按注册顺序派发');
});
