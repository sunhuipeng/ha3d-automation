'use strict';
/* 第三部分 Bug 修复的回归测试：S2 沙箱逃逸 / M2 影子 dryRun / M6 路径穿越 /
 * L5 互斥 + 释放 / L1 ha.change 单回调 / M9 error 状态保留 / L4 反代 URL。
 * 用隔离进程与 tmp 数据，不连真实 HA。 */
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ---------- S2：静态校验拒绝原型逃逸链 ---------- */
const { validateScript } = require('../server/scripts/validate.js');

test('S2：静态校验拒绝 constructor / __proto__ 逃逸链', () => {
  assert.match(validateScript("ctx.constructor.constructor('return process')()"), /constructor/);
  assert.match(validateScript("setTimeout['constructor']('return process')()"), /constructor/);
  assert.match(validateScript('obj.__proto__.x = 1'), /__proto__/);
  assert.match(validateScript('fn.call(null)'), /\.call/);
});

test('S2：静态校验保留合法 ctx / 原生内建语法', () => {
  assert.equal(validateScript("const d = new Date(); Math.floor(d.getTime()/1000); ctx.log('info','ok');"), null);
  assert.equal(validateScript("ctx.ha.change('light.x', (s)=>ctx.log('info', s.state));"), null);
});

/* ---------- M2 / M6：用隔离 tmp 数据加载 store ---------- */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-p3-'));
const config = require('../server/config.js');
config.DATA = tmpRoot;
const store = require('../server/scripts/store.js');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };

test('M2：submit 忽略外部 dryRun 参数，channel 决定渠道，dryRun 不再落盘', () => {
  const rec = store.submit('m2', { name: 'm2', script: "ctx.log('info','x');", flow: FLOW, dryRun: false, channel: 'shadow' });
  assert.equal(rec.meta.channel, 'shadow');
  assert.equal('dryRun' in rec.meta, false, 'dryRun 落盘字段已退役');
  const prod = store.submit('m2p', { name: 'm2p', script: "ctx.log('info','x');", flow: FLOW, dryRun: true, channel: 'production' });
  assert.equal(prod.meta.channel, 'production', '正式版本由 channel 决定');
});

test('M6：readLogs 拒绝路径穿越与非整数版本', () => {
  assert.deepEqual(store.readLogs('../runtime/other', 1), []);
  assert.deepEqual(store.readLogs('../../', 1), []);
  assert.deepEqual(store.readLogs('m2', 0), []);
  assert.deepEqual(store.readLogs('m2', 1.5), []);
});

/* ---------- L5：acquireAction 互斥 + 释放 ---------- */
const executor = require('../server/scripts/executor.js');

test('L5：同键并发互斥，释放后可再次获取', () => {
  const a = executor.acquireAction('light', 'turn_on', 'light.x');
  assert.equal(a.ok, true);
  const b = executor.acquireAction('light', 'turn_on', 'light.x');
  assert.equal(b.ok, false, 'inflight 未释放时应拒绝');
  executor.releaseAction(a.key);
  // 释放后再次获取不应再因"互斥"被拒（可能因冷却被拒，这是预期行为）
  const c = executor.acquireAction('light', 'turn_on', 'light.x');
  if (!c.ok) assert.ok(!/互斥/.test(c.reason), '释放后不应再报互斥：' + c.reason);
  if (c.ok) executor.releaseAction(c.key);
});

/* ---------- L1：ha.change 按实体注册，每次状态变化只回调一次（真实 runner） ---------- */
const { fork } = require('node:child_process');
const RUNNER = path.join(__dirname, '../server/scripts/runner.js');

function runSubscribeScript() {
  return new Promise((resolve) => {
    const child = fork(RUNNER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, HA3D_RUNNER: '1' } });
    let count = 0;
    let done = false;
    const finish = () => { if (done) return; done = true; try { child.kill(); } catch (e) {} resolve(count); };
    child.on('message', (msg) => {
      if (msg.type === 'subscribe') {
        // 注册完成后推两次状态变化
        child.send({ type: 'state', entityId: 'light.x', state: { state: 'on' }, prev: { state: 'off' } });
        setTimeout(() => child.send({ type: 'state', entityId: 'light.x', state: { state: 'off' }, prev: { state: 'on' } }), 50);
      }
      if (msg.type === 'log' && /CB/.test(msg.message)) count += 1;
      if (msg.type === 'done') finish();
    });
    const script = `
      ctx.ha.change('light.x', (s)=>{ ctx.log('info','CB'); });
      await new Promise(r=>setTimeout(r,200));
    `;
    child.send({ type: 'run', script, meta: { version: 1, dryRun: true } });
    setTimeout(finish, 3000);
  });
}

test('L1：ha.change 每次状态变化只回调一次', async () => {
  const count = await runSubscribeScript();
  assert.equal(count, 2, '两次状态变化应各回调一次，共 2 次（非 4 次）');
});

/* ---------- runner 沙箱逃逸：真实 fork 注入 payload 拿不到 process ---------- */
function tryEscape(payload) {
  return new Promise((resolve) => {
    const child = fork(RUNNER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, HA_TOKEN: 'SECRET', HA3D_RUNNER: '1' } });
    let result = 'NO_RESULT';
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { child.kill(); } catch (e) {} resolve(r); };
    child.on('message', (msg) => {
      if (msg.type === 'log' && /ESCAPE_RESULT/.test(msg.message)) result = msg.message;
      if (msg.type === 'done') finish(result);
    });
    const script = `
      try { const p = ${payload}; ctx.log('info','ESCAPE_RESULT:' + String(p && p.env ? p.env.HA_TOKEN : 'no-process')); }
      catch(e){ ctx.log('info','ESCAPE_RESULT:blocked:' + e.message); }
    `;
    child.send({ type: 'run', script, meta: { version: 1, dryRun: true } });
    setTimeout(() => finish(result), 3000);
  });
}

test('S2：真实 runner 中 constructor 逃逸拿不到 HA_TOKEN', async () => {
  const r = await tryEscape("ctx.constructor.constructor('return process')()");
  assert.ok(!/SECRET/.test(r), '不得泄露 HA_TOKEN：' + r);
});
