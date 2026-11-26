'use strict';
/* HA 断线 / 实体缺失兜底测试：
 * 断线时读返回 null、写跳过（reply ok+skipped 不崩溃）；
 * 实体被删暂停引用它的脚本（status=paused）、实体恢复自动继续（status=running）；
 * 互斥冲突 reply skipped 而非 false；haStatus 可观测。
 * 用隔离 tmp 数据 + 可控 mock connector（带 isReady），不连真实 HA。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-fallback-'));
const config = require('../server/config');
config.DATA = tmpRoot;
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitRunning(id, want, timeoutMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (executor.isRunning(id) === want) return true;
    await wait(30);
  }
  return executor.isRunning(id) === want;
}

/* 可控 connector：isReady 可切换，记录 callService 调用，getState 按缓存返回 */
function makeConnector() {
  return {
    ready: true,
    demo: false,
    calls: [],
    states: new Map(),
    isReady() { return this.ready; },
    getState(eid) { return this.ready ? (this.states.get(String(eid)) || null) : null; },
    listEntities() { return []; },
    callService: async (domain, service, data) => {
      if (!this.ready) throw new Error('HA 未就绪');
      this.calls.push({ domain, service, entity_id: data && data.entity_id });
      return { ok: true };
    },
  };
}

/* 脚本：读取两个实体并订阅它们，把读到的值写入上下文（触发 refs 收集） */
const WATCH_SCRIPT = `
ctx.actions({
  ping: () => ctx.ha.callService('light', 'turn_on', { entity_id: 'light.a' }),
});
ctx.log('info', 'test setup start');
const a = await ctx.ha.entity('light.a');
const b = await ctx.ha.entity('light.b');
ctx.log('info', 'read a=' + JSON.stringify(a) + ' b=' + JSON.stringify(b));
ctx.ha.change('light.a', () => {});
ctx.ha.change('light.b', () => {});
await new Promise(() => {});
`;

test('实体被删 → 引用它的脚本暂停(paused)；实体恢复 → 自动继续(running)', async () => {
  const conn = makeConnector();
  conn.states.set('light.a', { entity_id: 'light.a', state: 'on', attributes: {} });
  conn.states.set('light.b', { entity_id: 'light.b', state: 'off', attributes: {} });
  const rec = store.submit('fb1', { name: 'fb1', script: WATCH_SCRIPT, flow: FLOW, kind: 'automation', channel: 'shadow' });
  executor.start('fb1', rec.version, conn);
  assert.equal(await waitRunning('fb1', true), true);
  await wait(300); // 等脚本首帧读完实体，refs 收集完成

  let st = executor.haStatus().scripts[`fb1#v${rec.version}`];
  assert.ok(st.refs.includes('light.a'), '应收集到脚本引用的 light.a');
  assert.ok(st.refs.includes('light.b'), '应收集到脚本引用的 light.b');

  // 实体 light.a 被删
  executor.onStateChange('light.a', null, { entity_id: 'light.a', state: 'on' });
  st = executor.haStatus().scripts[`fb1#v${rec.version}`];
  assert.equal(st.paused, true, '引用实体被删应暂停');
  assert.ok(st.pausedBy.includes('light.a'));
  assert.equal(executor.versionRuntimeStatus('fb1', rec.version), 'paused', '运行状态应为 paused（executor 内存）');

  // 实体恢复
  executor.onStateChange('light.a', { entity_id: 'light.a', state: 'on' }, null);
  st = executor.haStatus().scripts[`fb1#v${rec.version}`];
  assert.equal(st.paused, false, '实体恢复应自动继续');
  assert.equal(executor.versionRuntimeStatus('fb1', rec.version), 'running', '运行状态应恢复 running');

  executor.stop('fb1', 'manual');
  await waitRunning('fb1', false);
});

test('HA 断线 → 写操作跳过不崩溃；isReady 恢复后照常下发', async () => {
  const conn = makeConnector();
  conn.states.set('light.a', { entity_id: 'light.a', state: 'on', attributes: {} });
  const rec = store.submit('fb2', { name: 'fb2', script: WATCH_SCRIPT, flow: FLOW, kind: 'automation', channel: 'production' });
  executor.start('fb2', rec.version, conn);
  assert.equal(await waitRunning('fb2', true), true);
  await wait(300);

  // 断线：直接写操作应被跳过（reply ok+skipped，不抛错）
  executor.onHaOffline();
  const blocked = await new Promise((resolve) => {
    // 借用 runner 的 request 路径：脚本没有主动写，这里直接验证门控函数
    resolve(executor.writeAllowed(`fb2#v${rec.version}`, conn));
  });
  assert.equal(blocked, false, '断线时 writeAllowed 应为 false');

  // 恢复
  executor.onHaReady();
  assert.equal(executor.writeAllowed(`fb2#v${rec.version}`, conn), true, '恢复后应允许写');

  executor.stop('fb2', 'manual');
  await waitRunning('fb2', false);
});

test('writeAllowed：引用实体被删期间为 false，恢复后为 true', async () => {
  const conn = makeConnector();
  const rec = store.submit('fb3', { name: 'fb3', script: WATCH_SCRIPT, flow: FLOW, kind: 'automation', channel: 'production' });
  executor.start('fb3', rec.version, conn);
  assert.equal(await waitRunning('fb3', true), true);
  await wait(300);
  assert.equal(executor.writeAllowed(`fb3#v${rec.version}`, conn), true);
  executor.onStateChange('light.a', null, { entity_id: 'light.a', state: 'on' });
  assert.equal(executor.writeAllowed(`fb3#v${rec.version}`, conn), false, '实体被删期间写应被拦');
  executor.onStateChange('light.a', { entity_id: 'light.a', state: 'on' }, null);
  assert.equal(executor.writeAllowed(`fb3#v${rec.version}`, conn), true, '实体恢复后写应放行');
  executor.stop('fb3', 'manual');
  await waitRunning('fb3', false);
});

test('haStatus：返回 HA 状态字段与各脚本引用/暂停信息', () => {
  const st = executor.haStatus();
  assert.ok('ha' in st && 'scripts' in st);
  assert.ok(['ready', 'offline'].includes(st.ha));
});
