'use strict';
/* 框架依赖场景能力专项测试（下沉三件套，task.watch 已删除、防抖统一走写者折叠通道）：
 * ① ctx.global.watch 默认回放：注册即拉当前值回调一次（prev=null、source='replay'），
 *    桶无值不回调；真实 contextChange 先到则丢弃回放值。
 * ② ctx.gate()：忙时合并执行门——空闲立即执行返回 true，忙时合并 pending 只补跑
 *    最后一次；fn 异常记 error 日志不中断脚本。
 * 复用 mock 宿主模式（fork runner.js，不连接真实 HA）。 */
import { fork } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, '../server/scripts/runner.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runWithMockHost(script, { meta = {}, onRequest, onSubscribe } = {}) {
  return new Promise((resolve) => {
    const child = fork(RUNNER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, HA3D_RUNNER: '1' } });
    const logs = [];
    const hostMsgs = [];
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch (e) {}
      resolve({ logs, hostMsgs, text: logs.map((l) => l.message).join('\n') });
    };
    child.on('message', (msg) => {
      hostMsgs.push(msg);
      if (msg.type === 'request') {
        Promise.resolve()
          .then(() => onRequest ? onRequest(msg.action, msg.data, child) : null)
          .then((result) => child.send({ type: 'reply', id: msg.id, ok: true, result }))
          .catch((e) => child.send({ type: 'reply', id: msg.id, ok: false, error: String(e && e.message || e) }));
      }
      if (msg.type === 'log') logs.push(msg);
      if (msg.type === 'contextSubscribe' && onSubscribe) onSubscribe(msg, child);
      if (msg.type === 'taskSubscribe' && onSubscribe) onSubscribe(msg, child);
      if (msg.type === 'done') finish();
    });
    timer = setTimeout(finish, 5000);
    child.send({ type: 'run', script, meta: { version: 1, dryRun: true, sid: 'self', ...meta } });
  });
}

/* ---------- ① ctx.global.watch 默认回放 ---------- */

test('global.watch：桶有值时注册即收到 replay 回调（prev=null）', async () => {
  const { text } = await runWithMockHost(`
    ctx.global.watch('home.x', (v, prev, info) => {
      ctx.log('info', 'W:' + v + ':' + prev + ':' + (info.source || 'event'));
    });
    await ctx.sleep(120);
  `, {
    onRequest: (action) => (action === 'contextGet' ? 'on' : null),
  });
  assert.match(text, /W:on:null:replay/, '注册即回放当前值，info.source=replay');
});

test('global.watch：桶无值不回放（fallback 场景留给 get）', async () => {
  const { text } = await runWithMockHost(`
    ctx.global.watch('home.empty', () => ctx.log('info', 'SHOULD_NOT_FIRE'));
    await ctx.sleep(120);
  `, {
    onRequest: (action) => (action === 'contextGet' ? undefined : null),
  });
  assert.doesNotMatch(text, /SHOULD_NOT_FIRE/);
});

test('global.watch：真实事件先到则丢弃回放值（以事件为准）', async () => {
  const { text } = await runWithMockHost(`
    ctx.global.watch('home.race', (v, prev, info) => {
      ctx.log('info', 'W:' + v + ':' + (info.source || 'event'));
    });
    await ctx.sleep(200);
  `, {
    onRequest: (action, data, child) => {
      if (action !== 'contextGet') return null;
      /* 先派发真实事件，再让回放值迟到：回放值必须被丢弃 */
      child.send({ type: 'contextChange', scope: 'global', key: data.key, value: 'real', prev: null, namespace: 'production' });
      return sleep(100).then(() => 'late');
    },
  });
  assert.match(text, /W:real:event/, '真实事件正常派发');
  assert.doesNotMatch(text, /W:late/, '迟到的回放值被丢弃');
});

test('global.watch：off() 后回放值不回调', async () => {
  const { text } = await runWithMockHost(`
    const off = ctx.global.watch('home.off', () => ctx.log('info', 'SHOULD_NOT_FIRE'));
    off();
    await ctx.sleep(120);
  `, {
    onRequest: (action) => (action === 'contextGet' ? 'on' : null),
  });
  assert.doesNotMatch(text, /SHOULD_NOT_FIRE/);
});

/* ---------- ② ctx.gate 合并门 ---------- */

test('gate：空闲立即执行返回 true，忙时合并 pending 只补跑最后一次', async () => {
  const { text } = await runWithMockHost(`
    const gate = ctx.gate();
    const first = gate.run(async () => {
      ctx.log('info', 'RUN:1:start');
      await ctx.sleep(120);
      ctx.log('info', 'RUN:1:end');
    });
    ctx.log('info', 'IMM:' + await first);
    const b = gate.run(async () => { ctx.log('info', 'RUN:2'); });
    const c = gate.run(async () => { ctx.log('info', 'RUN:3'); });
    ctx.log('info', 'BUSY:' + await b + ':' + await c);
    await ctx.sleep(400); // 顶层必须等 gate 的异步续体跑完（done 即回收子进程）
  `);
  assert.match(text, /IMM:true/, '空闲调用立即执行');
  assert.match(text, /BUSY:false:false/, '忙时调用被合并');
  assert.doesNotMatch(text, /RUN:2/, '中间的 pending 被最新一次取代');
  assert.match(text, /RUN:1:start[\s\S]*RUN:1:end[\s\S]*RUN:3/, '补跑发生在首次执行结束后');
});

test('gate：fn 异常记 error 日志，脚本不中断、门可继续使用', async () => {
  const { text } = await runWithMockHost(`
    const gate = ctx.gate();
    gate.run(async () => { throw new Error('boom'); });
    await ctx.sleep(60);
    const ok = await gate.run(async () => { ctx.log('info', 'AFTER_ERROR'); });
    ctx.log('info', 'REUSE:' + ok);
    await ctx.sleep(30);
  `);
  assert.match(text, /gate 执行异常：boom/);
  assert.match(text, /AFTER_ERROR/);
  assert.match(text, /REUSE:true/, '异常后门状态复位可复用');
});
