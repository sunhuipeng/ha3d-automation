'use strict';
/* 审计修复回归（2026-11-24 第一轮体检）：
 * 1. P0-1  diff 合并不丢属性（状态变更分支同样与旧属性合并，"+" 包装解包）
 * 2. entityStatus 三态（unknown/present/missing）—— 供 get_state 语义与断线实体复核
 * 3. P0-4  rollback 走 executor：运行中的影子先停，不占影子槽位
 * 4. P1-18 列表 status/name 展示口径正式版优先
 * 5. D5    dryRun 旧参数被忽略（channel 派生），传入不生效 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);

/* ---------- 连接器（不连真实 HA，直接驱动 diff 方法） ---------- */
import { HaConnector } from '../server/ha/connector.js';

function makeConnector() {
  return new HaConnector({ getConfig: () => ({ haUrl: '', token: '' }) });
}

test('P0-1 diff 合并：状态变更 + 部分属性 diff 不丢旧属性', () => {
  const c = makeConnector();
  c.entities.set('light.x', { entity_id: 'light.x', state: 'off', attributes: { friendly_name: '客厅灯', brightness: 100 } });
  c._applyEntityDiff({ c: { 'light.x': { s: 'on', a: { brightness: 80 } } } });
  const e = c.entities.get('light.x');
  assert.equal(e.state, 'on');
  assert.equal(e.attributes.friendly_name, '客厅灯', '未变属性不得丢失');
  assert.equal(e.attributes.brightness, 80, '变更属性生效');
});

test('P0-1 diff 合并："+" 包装与纯属性 diff', () => {
  const c = makeConnector();
  c.entities.set('light.y', { entity_id: 'light.y', state: 'off', attributes: { friendly_name: '卧室灯' } });
  /* "+" 包装（属性为部分 diff） */
  c._applyEntityDiff({ c: { 'light.y': { '+': { a: { effect: 'none' } } } } });
  let e = c.entities.get('light.y');
  assert.equal(e.state, 'off');
  assert.equal(e.attributes.effect, 'none');
  assert.equal(e.attributes.friendly_name, '卧室灯');
  /* 纯属性 diff（无 s） */
  c._applyEntityDiff({ c: { 'light.y': { a: { brightness: 7 } } } });
  e = c.entities.get('light.y');
  assert.equal(e.attributes.brightness, 7);
  assert.equal(e.attributes.friendly_name, '卧室灯');
});

test('P0-1 全量快照归一同样合并旧属性', () => {
  const c = makeConnector();
  c.entities.set('sensor.t', { entity_id: 'sensor.t', state: '20', attributes: { friendly_name: '室温', unit: '°C' } });
  const next = c._normSnapshot('sensor.t', { s: '21', a: { battery: 90 } }, c.entities.get('sensor.t'));
  assert.equal(next.state, '21');
  assert.equal(next.attributes.friendly_name, '室温');
  assert.equal(next.attributes.unit, '°C');
  assert.equal(next.attributes.battery, 90);
});

test('entityStatus 三态：未就绪 unknown / 就绪后 present|missing', () => {
  const c = makeConnector();
  assert.equal(c.entityStatus('light.a'), 'unknown');
  c.ready = true;
  c.entities.set('light.a', { entity_id: 'light.a', state: 'on', attributes: {} });
  assert.equal(c.entityStatus('light.a'), 'present');
  assert.equal(c.entityStatus('light.gone'), 'missing');
});

/* ---------- store/executor（隔离 tmp 数据目录） ---------- */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-audit-'));
const config = require('../server/config');
config.DATA = tmpRoot;
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }, { id: 'n2', type: 'action' }], edges: [{ from: 'n1', to: 'n2' }] };
const SCRIPT = `ctx.log('info', 'audit ok', 'n1');\nawait new Promise(() => {});\n`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('D5 提交传 dryRun=false 不影响影子派生（旧参数被忽略，字段不再落盘）', () => {
  const rec = store.submit('auditdry', { name: '审计dryRun', script: SCRIPT, flow: FLOW, dryRun: false });
  assert.equal(rec.meta.channel, 'shadow', 'channel 决定渠道，外部 dryRun 传值必须被忽略');
  assert.equal('dryRun' in rec.meta, false, 'dryRun 落盘字段已退役');
});

test('P0-4 rollback：运行中的影子先停，归档不占影子槽位', async () => {
  const rec = store.submit('auditrb', { name: '审计回滚', script: SCRIPT, flow: FLOW });
  store.publish('auditrb', rec.version); // v1 → 正式
  const rec2 = store.submit('auditrb', { name: '审计回滚', script: SCRIPT, flow: FLOW }); // v2 影子
  const mockConn = { isReady: () => true };
  executor.start('auditrb', rec2.version, mockConn);
  const t0 = Date.now();
  while (!executor.isRunning('auditrb') && Date.now() - t0 < 3000) await wait(30);
  assert.ok(executor.isRunning('auditrb'), '前置：影子已运行');
  const rb = executor.rollback('auditrb', rec.version); // 从正式 v1 回滚
  await wait(800); // 等宽限期归位
  assert.equal(executor.isRunning('auditrb'), false, '被归档的旧影子实例已停止');
  assert.notEqual(rb.version, rec2.version, '回滚产生新影子版本');
  /* 新影子可正常启动（槽位未被归档版本占用） */
  const again = store.versionOfChannel('auditrb', 'shadow');
  assert.equal(again, rb.version, '归档后的影子指针指向回滚新版本');
  executor.start('auditrb', again, mockConn);
  const t1 = Date.now();
  while (!executor.isRunning('auditrb') && Date.now() - t1 < 3000) await wait(30);
  assert.ok(executor.isRunning('auditrb'), '新影子可启动（槽位已释放）');
  executor.stop('auditrb', 'test');
  await wait(700);
});

test('P1-18 列表 status/name 展示口径正式版优先', () => {
  store.submit('auditdisp', { name: '正式显示名', script: SCRIPT, flow: FLOW });
  store.publish('auditdisp');
  store.submit('auditdisp', { name: '影子新名字', script: SCRIPT, flow: FLOW });
  const row = store.list().find((s) => s.id === 'auditdisp');
  assert.equal(row.name, '正式显示名', 'name 来自正式版 meta，不被影子改名覆盖');
  assert.equal(row.updatedAt, store.getMeta('auditdisp', 2).updatedAt, 'updatedAt=最新版本的定稿时间（影子提交/发布时间）');
  assert.equal(row.shadowVersion, 2);
  assert.equal(row.productionVersion, 1);
});
