'use strict';
/* 接管方案批次四：脚本间联动（ctx.call）+ global 变更监听（ctx.global.watch）。
 * 三层覆盖：AST 白名单 / context 事件源 / runner 协议 / executor 端到端。
 * 全部使用临时 DATA 与 mock connector，不碰真实 HA，也不设 DEV_MODE。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-batch4-'));
const config = require('../server/config');
config.DATA = tmpRoot; // 必须在 require context/store 之前覆盖
const context = require('../server/scripts/context');
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');
const { validateScript } = require('../server/scripts/validate');
const RUNNER = path.join(__dirname, '../server/scripts/runner.js');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
const connector = {
  demo: false,
  getState: () => ({ state: 'off', attributes: {} }),
  listEntities: () => [],
  callService: async () => ({ ok: true }),
};

function waitUntil(pred, label, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let v = false;
      try { v = pred(); } catch (e) {}
      if (v) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return reject(new Error('等待超时：' + label));
      setTimeout(tick, 25);
    };
    tick();
  });
}
function waitDone(sid, timeoutMs = 8000) {
  return waitUntil(() => !executor.isRunning(sid), sid + ' 结束', timeoutMs);
}
function logText(sid, version) {
  return store.readLogs(sid, version).map((x) => String(x.message || '')).join('\n');
}

/* runner 层：mock 主进程，验证 ctx 发协议 + 处理 reply/contextChange */
function runRunner(script, { meta = {}, handler = () => {} } = {}) {
  const child = fork(RUNNER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, HA3D_RUNNER: '1' } });
  const msgs = [];
  const logs = [];
  child.on('message', (msg) => {
    msgs.push(msg);
    if (msg.type === 'log') logs.push(String(msg.message));
    if (msg.type === 'request') handler(msg, child);
  });
  child.send({ type: 'run', script, meta: { version: 1, dryRun: true, ...meta } });
  return {
    child, msgs, logs,
    text: () => logs.join('\n'),
    wait: (pred, label) => waitUntil(() => pred(msgs, logs), label, 5000),
    close: () => { try { child.kill(); } catch (e) {} },
  };
}

test('AST：ctx.call 放行，借道 Function.prototype 的 .call 仍拒绝', () => {
  assert.equal(validateScript("await ctx.call('other', { x: 1 });"), null);
  assert.equal(validateScript("ctx['call']('other');"), null);
  assert.match(validateScript('obj.call(null);') || '', /禁止成员访问：\.call/);
  assert.match(validateScript('ctx.global.set.call(null, 1);') || '', /禁止成员访问：\.call/);
});

test('context：变更事件带命名空间/写者/旧值，同值与非 global 不发', async () => {
  const events = [];
  const off = context.onChange((e) => events.push(e));
  await context.set('global', 'writerX', 'sig.a', { n: 1 }, true);
  await context.set('global', 'writerX', 'sig.a', { n: 1 }, true); // 同值
  await context.set('global', 'writerX', 'sig.a', { n: 2 }, true);
  await context.set('global', 'writerX', 'sig.a', { n: 1 }, false); // production 桶
  await context.set('local', 'writerX', 'sig.a', 9, true);          // local 不发
  off();
  assert.equal(events.length, 3);
  assert.equal(events[0].namespace, 'shadow');
  assert.deepEqual(events[0].prev, null);
  assert.deepEqual(events[0].value, { n: 1 });
  assert.equal(events[0].writerSid, 'writerX');
  assert.deepEqual(events[1].prev, { n: 1 });
  assert.equal(events[2].namespace, 'production');
});

test('runner：ctx.global.watch 注册/回调/取消订阅协议', async () => {
  const r = runRunner(`
    const off = ctx.global.watch('sig.b', (v, p, info) => {
      ctx.log('info', 'WATCH:' + JSON.stringify(v) + ':' + JSON.stringify(p) + ':' + info.writerSid + ':' + info.namespace);
    });
    ctx.log('info', 'READY');
    await ctx.sleep(350);
    off();
    ctx.log('info', 'OFF');
    await ctx.sleep(150);
  `);
  try {
    await r.wait((msgs) => msgs.some((m) => m.type === 'contextSubscribe' && m.key === 'sig.b'), 'subscribe');
    r.child.send({ type: 'contextChange', scope: 'global', key: 'sig.b', value: 7, prev: null, writerSid: 'writerY', namespace: 'shadow' });
    await r.wait((msgs, logs) => logs.some((l) => l.startsWith('WATCH:')), 'watch 回调');
    assert.match(r.text(), /WATCH:7:null:writerY:shadow/);
    await r.wait((msgs) => msgs.some((m) => m.type === 'contextUnsubscribe' && m.key === 'sig.b'), 'unsubscribe');
    r.child.send({ type: 'contextChange', scope: 'global', key: 'sig.b', value: 8, prev: 7, writerSid: 'writerY', namespace: 'shadow' });
    await r.wait((msgs, logs) => logs.includes('OFF'), 'OFF');
    assert.equal(r.logs.filter((l) => l.startsWith('WATCH:')).length, 1, '取消订阅后不应再回调');
  } finally { r.close(); }
});

test('runner：ctx.call 发 callScript 请求，回执交回脚本；失败回执转异常', async () => {
  const calls = [];
  const r = runRunner(`
    try { const r = await ctx.call('calleeZ', { x: 1 }); ctx.log('info', 'CALL:' + JSON.stringify(r)); }
    catch (e) { ctx.log('info', 'ERR:' + e.message); }
    try { await ctx.call('badZ'); } catch (e) { ctx.log('info', 'ERR2:' + e.message); }
    try { const cyc = {}; cyc.self = cyc; await ctx.call('badZ', cyc); } catch (e) { ctx.log('info', 'ERR3:' + e.message); }
  `, {
    handler: (msg, child) => {
      if (msg.action !== 'callScript') return;
      calls.push(msg.data);
      if (msg.data.scriptId === 'calleeZ') {
        child.send({ type: 'reply', id: msg.id, ok: true, result: { id: 'calleeZ', version: 2, started: true } });
      } else {
        child.send({ type: 'reply', id: msg.id, ok: false, error: '目标不存在' });
      }
    },
  });
  await r.wait((msgs, logs) => logs.some((l) => l.startsWith('ERR3:')), 'ctx.call 完成');
  assert.deepEqual(calls[0], { scriptId: 'calleeZ', params: { x: 1 } });
  assert.match(r.text(), /CALL:\{"id":"calleeZ","version":2,"started":true\}/);
  assert.match(r.text(), /ERR2:目标不存在/);
  assert.match(r.text(), /ERR3:ctx\.call 的 params 必须可 JSON 序列化/);
  r.close();
});

test('executor：ctx.call 影子调用 mock 不拉起被调方；正式调用真实拉起', async () => {
  const callee = store.submit('calleb4', {
    name: '被调场景', script: `ctx.log('info', 'CALLED:' + JSON.stringify(ctx.params));`, flow: FLOW,
    kind: 'scene',
  });
  const caller = store.submit('callb4', {
    name: '调用方', script: `
      try { const r = await ctx.call('calleb4', { x: 7 }); ctx.log('info', 'CALL:' + JSON.stringify(r)); }
      catch (e) { ctx.log('info', 'ERR:' + e.message); }
    `, flow: FLOW, kind: 'script',
  });
  executor.start('callb4', caller.version, connector);
  await waitDone('callb4');
  /* 影子调用：只回 mock 回执，被调脚本永不执行 */
  assert.match(logText('callb4', caller.version),
    /CALL:\{"id":"calleb4","version":1,"mode":"shadow","started":true,"mocked":true\}/);
  assert.match(logText('callb4', caller.version), /\[联动\]\[影子\] 调用 calleb4 v1 已 mock/);
  assert.equal(executor.isRunning('calleb4'), false, '影子调用不得真实拉起被调脚本');
  assert.ok(!logText('calleb4', callee.version).includes('CALLED'), '被调脚本不应产生任何日志');

  /* 正式调用者：真实拉起正式版本，params 注入 ctx.params */
  store.submit('calleb4', {
    name: '被调场景', script: `ctx.log('info', 'CALLED:' + JSON.stringify(ctx.params));`, flow: FLOW,
    kind: 'scene', channel: 'production',
  });
  const callerP = store.submit('callb4p', {
    name: '正式调用方', script: `
      try { const r = await ctx.call('calleb4', { x: 9 }); ctx.log('info', 'CALL:' + JSON.stringify(r)); }
      catch (e) { ctx.log('info', 'ERR:' + e.message); }
    `, flow: FLOW, kind: 'script', channel: 'production',
  });
  executor.start('callb4p', callerP.version, connector);
  await waitDone('callb4p');
  await waitDone('calleb4');
  assert.match(logText('callb4p', callerP.version),
    /CALL:\{"id":"calleb4","version":2,"mode":"production","started":true\}/);
  assert.match(logText('calleb4', 2), /CALLED:\{"x":9\}/, '正式调用应真实执行被调脚本并注入 params');

  /* 只存在正式版的目标：影子调用者仍报「没有影子版本」（校验与正式路径一致） */
  store.submit('onlyprod4', { name: '仅正式', script: `ctx.log('info','x');`, flow: FLOW, channel: 'production', kind: 'script' });
  const caller2 = store.submit('callb4b', {
    name: '跨命名空间调用', script: `
      try { await ctx.call('onlyprod4'); } catch (e) { ctx.log('info', 'ERR:' + e.message); }
    `, flow: FLOW, kind: 'script',
  });
  executor.start('callb4b', caller2.version, connector);
  await waitDone('callb4b');
  assert.match(logText('callb4b', caller2.version), /ERR:被调脚本 onlyprod4 没有影子版本/);
  assert.equal(executor.isRunning('onlyprod4'), false, '影子调用不得触发正式版本');

  /* 常驻脚本不可被调用（影子 mock 也保留此校验） */
  store.submit('liveb4', { name: '常驻目标', script: `await ctx.keepAlive();`, flow: FLOW, kind: 'automation' });
  const caller3 = store.submit('callb4c', {
    name: '调常驻', script: `
      try { await ctx.call('liveb4'); } catch (e) { ctx.log('info', 'ERR:' + e.message); }
    `, flow: FLOW, kind: 'script',
  });
  executor.start('callb4c', caller3.version, connector);
  await waitDone('callb4c');
  assert.match(logText('callb4c', caller3.version), /ERR:只能调用动作\/场景类一次性脚本/);
  assert.equal(executor.isRunning('liveb4'), false, '常驻脚本不应被 ctx.call 启动');
});

test('executor：ctx.call 防递归深度、防重入（被调实例已在跑）', async () => {
  const deep = store.submit('deepcall4', {
    name: '深度调用', script: `
      try { await ctx.call('calleb4'); } catch (e) { ctx.log('info', 'ERR:' + e.message); }
    `, flow: FLOW, kind: 'script',
  });
  executor.start('deepcall4', deep.version, connector, 0, { callDepth: 5 });
  await waitDone('deepcall4');
  assert.match(logText('deepcall4', deep.version), /ERR:调用链深度超过 5 层/);

  const slow = store.submit('slowb4', {
    name: '慢动作', script: `await ctx.sleep(600); ctx.log('info','SLOW_DONE');`, flow: FLOW, kind: 'script',
  });
  store.submit('slowb4', {
    name: '慢动作', script: `await ctx.sleep(600); ctx.log('info','SLOW_DONE');`, flow: FLOW, kind: 'script',
    channel: 'production',
  });
  const caller = store.submit('recallb4', {
    name: '重复调用', script: `
      try { await ctx.call('slowb4'); } catch (e) { ctx.log('info', 'ERR:' + e.message); }
    `, flow: FLOW, kind: 'script', channel: 'production',
  });
  executor.start('slowb4', 2, connector); // 正式版本（v2）
  executor.start('recallb4', caller.version, connector);
  await waitDone('recallb4');
  assert.match(logText('recallb4', caller.version), /ERR:被调脚本正在执行中/);
  executor.stop('slowb4', 'test');
});

const WATCHER = `
ctx.global.watch('sig.c', (v, p, info) => {
  ctx.log('info', 'WATCH:' + JSON.stringify(v) + ':' + JSON.stringify(p) + ':' + info.writerSid + ':' + info.namespace);
});
ctx.log('info', 'READY');
await ctx.keepAlive();
`;
const WRITER = `
ctx.global.watch('sig.c', () => ctx.log('info', 'SELF'));
await ctx.global.set('sig.c', { n: 1 });
await ctx.global.set('sig.c', { n: 1 });
await ctx.global.set('sig.c', { n: 2 });
ctx.log('info', 'WRITER_DONE');
`;

test('executor：ctx.global.watch 同值不发、写者不自触发（读统一正式命名空间）', async () => {
  const w = store.submit('watchb4', { name: '监听者', script: WATCHER, flow: FLOW, kind: 'automation' });
  const wr = store.submit('writerb4', { name: '写者', script: WRITER, flow: FLOW, kind: 'script', channel: 'production' });
  executor.start('watchb4', w.version, connector);
  await waitUntil(() => logText('watchb4', w.version).includes('READY'), '监听者就绪');
  executor.start('writerb4', wr.version, connector);
  await waitDone('writerb4');
  await waitUntil(() => logText('watchb4', w.version).split('\n').filter((l) => l.startsWith('WATCH:')).length >= 2, '两次变更');
  const lines = logText('watchb4', w.version).split('\n').filter((l) => l.startsWith('WATCH:'));
  assert.equal(lines.length, 2, '同值 set 不应重复触发');
  assert.ok(lines.includes('WATCH:{"n":1}:null:writerb4:production'));
  assert.ok(lines.includes('WATCH:{"n":2}:{"n":1}:writerb4:production'));
  assert.ok(!logText('writerb4', wr.version).includes('SELF'), '写者不应收到自己的变更');
  executor.stop('watchb4', 'test');
});

test('executor：写仍隔离，读不隔离——影子写入无人收到，正式写入所有监听者都收到', async () => {
  const shadowW = store.submit('wshadow4', { name: '影子监听', script: WATCHER, flow: FLOW, kind: 'automation' });
  const prodW = store.submit('wprod4', { name: '正式监听', script: WATCHER, flow: FLOW, kind: 'automation', channel: 'production' });
  const shadowWriter = store.submit('crossb4', {
    name: '影子写者',
    script: `await ctx.global.set('sig.c', { n: 8 }); ctx.log('info','DONE');`,
    flow: FLOW, kind: 'script',
  });
  const prodWriter = store.submit('crossprod', {
    name: '正式写者',
    script: `await ctx.global.set('sig.c', { n: 9 }); ctx.log('info','DONE');`,
    flow: FLOW, channel: 'production',
  });
  executor.start('wshadow4', shadowW.version, connector);
  executor.start('wprod4', prodW.version, connector);
  await waitUntil(() => logText('wshadow4', shadowW.version).includes('READY'), '影子监听就绪');
  await waitUntil(() => logText('wprod4', prodW.version).includes('READY'), '正式监听就绪');

  executor.start('crossb4', shadowWriter.version, connector);
  await waitDone('crossb4');
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(!logText('wshadow4', shadowW.version).includes('WATCH:{"n":8}'), '影子写入不应触发任何监听者');
  assert.ok(!logText('wprod4', prodW.version).includes('WATCH:{"n":8}'), '影子写入不应触发任何监听者');

  executor.start('crossprod', prodWriter.version, connector);
  await waitDone('crossprod');
  await waitUntil(() => logText('wshadow4', shadowW.version).includes('WATCH:{"n":9}'), '影子监听收到正式写入');
  await waitUntil(() => logText('wprod4', prodW.version).includes('WATCH:{"n":9}'), '正式监听收到正式写入');
  assert.match(logText('wshadow4', shadowW.version), /WATCH:\{"n":9\}:.*:crossprod:production/);
  assert.match(logText('wprod4', prodW.version), /WATCH:\{"n":9\}:.*:crossprod:production/);
  executor.stop('wshadow4', 'test');
  executor.stop('wprod4', 'test');
});

test('executor：影子脚本 ctx.global.get 读到正式命名空间的值', async () => {
  const seed = store.submit('prodseed', {
    name: '正式种子', script: `await ctx.global.set('sig.read', { v: 7 });`, flow: FLOW, channel: 'production',
  });
  const reader = store.submit('shadowreader', {
    name: '影子读者',
    script: `const v = await ctx.global.get('sig.read', null); ctx.log('info', 'READ:' + JSON.stringify(v));`,
    flow: FLOW, kind: 'script',
  });
  executor.start('prodseed', seed.version, connector);
  await waitDone('prodseed');
  executor.start('shadowreader', reader.version, connector);
  await waitDone('shadowreader');
  assert.match(logText('shadowreader', reader.version), /READ:\{"v":7\}/);
});
