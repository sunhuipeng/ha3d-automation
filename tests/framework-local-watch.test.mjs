'use strict';
/* ctx.local.watch 专项测试（2026-11-28）：
 * ① 默认回放：桶有值注册即回调一次（prev=null、source='replay'）；桶无值不回放。
 * ② ctx.local.set 变化触发 watch（value/prev/info.source='set'）；同值不触发。
 * ③ 真实事件先到丢弃在途回放值。
 * ④ off() 后不再收到通知。
 * ⑤ 仿真注入（contextChange scope=local）能触发 watch。
 * mock 宿主维护一个内存 local 桶，正确应答 contextGet/contextSet，不连真实 HA。 */
import { fork } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, '../server/scripts/runner.js');

function runWithMockHost(script, { seed = {}, inject = null, injectAt = 100, slowGet = 0 } = {}) {
  return new Promise((resolve) => {
    const child = fork(RUNNER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, HA3D_RUNNER: '1' } });
    const local = { ...seed };
    const logs = [];
    let settled = false;
    let timer = null;
    let injectTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (injectTimer) clearTimeout(injectTimer);
      try { child.kill(); } catch (e) {}
      resolve({ text: logs.map((l) => l.message).join('\n') });
    };
    child.on('message', (msg) => {
      if (msg.type === 'log') logs.push(msg);
      if (msg.type === 'request') {
        const { id, action, data } = msg;
        if (action === 'contextGet') {
          const v = Object.prototype.hasOwnProperty.call(local, data.key) ? local[data.key] : data.default;
          const reply = () => child.send({ type: 'reply', id, ok: true, result: v });
          return slowGet ? setTimeout(reply, slowGet) : reply();
        }
        if (action === 'contextSet') {
          local[data.key] = data.value;
          return child.send({ type: 'reply', id, ok: true, result: { ok: true } });
        }
        return child.send({ type: 'reply', id, ok: true, result: null });
      }
      if (msg.type === 'done') finish();
    });
    timer = setTimeout(finish, 5000);
    if (inject) {
      injectTimer = setTimeout(() => {
        child.send({ type: 'contextChange', scope: 'local', ...inject });
      }, injectAt);
    }
    child.send({ type: 'run', script, meta: { version: 1, dryRun: true, sid: 'self' } });
  });
}

test('local.watch：默认回放——桶有值回调一次（prev=null、source=replay），桶无值不回放', async () => {
  const { text } = await runWithMockHost(`
    ctx.local.watch('has', (v, prev, info) => ctx.log('info', 'HAS:' + v + ':' + prev + ':' + (info && info.source)));
    ctx.local.watch('none', () => ctx.log('info', 'NONE_REPLAY'));
    await ctx.sleep(120);
  `, { seed: { has: 7 } });
  assert.match(text, /HAS:7:null:replay/, '桶有值：注册即回放');
  assert.doesNotMatch(text, /NONE_REPLAY/, '桶无值：不回放');
});

test('local.watch：set 变化触发（value/prev/source=set），同值不触发', async () => {
  const { text } = await runWithMockHost(`
    ctx.local.watch('k', (v, prev, info) => ctx.log('info', 'W:' + v + ':' + prev + ':' + (info && info.source)));
    await ctx.local.set('k', 1);
    await ctx.local.set('k', 1);          // 同值：不触发
    await ctx.local.set('k', 2);
    await ctx.sleep(120);
  `);
  const fires = [...text.matchAll(/W:(\d+):(\w+):(\w+)/g)].map((m) => m.slice(1).join(':'));
  assert.deepEqual(fires, ['1:null:set', '2:1:set'], '只两次真实变化，prev 正确');
});

test('local.watch：真实事件先到则丢弃在途回放值', async () => {
  /* 让 contextGet 回执延迟 60ms，注入在 10ms 先到 → 回放请求到达时被判为在途并丢弃 */
  const { text } = await runWithMockHost(`
    ctx.local.watch('k', (v, prev, info) => ctx.log('info', 'W:' + v + ':' + (info && info.source)));
    await ctx.sleep(160);
  `, { seed: { k: 1 }, slowGet: 60, inject: { key: 'k', value: 9, prev: 1, source: 'set' }, injectAt: 10 });
  assert.match(text, /W:9:set/, '真实事件胜出');
  assert.doesNotMatch(text, /W:1:replay/, '回放值被丢弃');
});

test('local.watch：off() 后不再收到通知', async () => {
  const { text } = await runWithMockHost(`
    const off = ctx.local.watch('k', (v) => ctx.log('info', 'W:' + v));
    await ctx.local.set('k', 1);
    off();
    await ctx.local.set('k', 2);
    await ctx.sleep(120);
  `);
  assert.match(text, /W:1/, 'off 前变化正常收到');
  assert.doesNotMatch(text, /W:2/, 'off 后不再收到');
});

test('local.watch：仿真注入 contextChange scope=local 能触发 watch', async () => {
  const { text } = await runWithMockHost(`
    ctx.local.watch('k', (v, prev, info) => ctx.log('info', 'EXT:' + v + ':' + prev + ':' + (info && info.source)));
    await ctx.sleep(300);
  `, { inject: { key: 'k', value: 42, prev: null, source: 'inject' }, injectAt: 100 });
  assert.match(text, /EXT:42:null:inject/, '外部 local 注入触发 watch');
});
