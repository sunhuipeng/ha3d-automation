'use strict';
/* 全局上下文写者身份单测（2026-11-27 全链路改造①）：
 * 单写者约定落地——写者身份落盘（writers meta 分表）、接管告警、keysByWriter 反查、
 * 旧 context.json 懒迁移（裸值 → 无写者，首次 set 后自动盖章）。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-ctx-writers-'));
const config = require('../server/config');
config.DATA = tmpRoot; // 必须在 require context 之前覆盖

/* 预置旧格式 context.json（裸值、无 writers 表），验证懒迁移 */
fs.writeFileSync(path.join(tmpRoot, 'context.json'), JSON.stringify({
  global: { production: { 'home.legacy': true }, shadow: {} },
  local: {},
}, null, 2));

const context = require('../server/scripts/context');

test('旧格式懒迁移：裸值保留、writerOf 为 null、writers 表自动补齐', () => {
  assert.equal(context.get('global', 'any', 'home.legacy', false), true, '存量值读取不变');
  assert.equal(context.writerOf('home.legacy', false), null, '存量键写者未知');
  /* 懒迁移只规范化内存缓存；落盘在下一次 set 的写链里连带 writers 表完成 */
  assert.deepEqual(context.snapshot(false).writers, {}, 'writers 表（内存）已补齐为空');
});

test('set 盖章写者身份；get 返回裸值不受影响', async () => {
  await context.set('global', 'm7orioe9', 'home.highPower', true, false);
  assert.equal(context.get('global', 'm7orioe9', 'home.highPower', false), true);
  assert.equal(context.writerOf('home.highPower', false), 'm7orioe9');
  assert.equal(context.writerOf('home.highPower', true), null, '影子桶写者独立');
  await context.set('global', 'm7orioe9', 'home.highPower', false, true);
  assert.equal(context.writerOf('home.highPower', true), 'm7orioe9');
});

test('keysByWriter 反查写者写过的全部 key', async () => {
  await context.set('global', 'writer-a', 'k.one', 1, false);
  await context.set('global', 'writer-a', 'k.two', 2, false);
  await context.set('global', 'writer-b', 'k.three', 3, false);
  const keys = context.keysByWriter('production', 'writer-a').sort();
  assert.deepEqual(keys, ['k.one', 'k.two']);
  assert.deepEqual(context.keysByWriter('production', 'writer-ghost'), []);
});

test('单写者约定：被其他脚本接管时发 warning（软约束不拒绝）', async () => {
  const warned = new Promise((resolve) => process.once('warning', (w) => resolve(String(w.message || w))));
  await context.set('global', 'writer-a', 'k.takeover', 'a1', false);
  await context.set('global', 'writer-b', 'k.takeover', 'b1', false); // 接管：必须告警
  const msg = await warned;
  assert.match(msg, /单写者约定告警/, '告警文案');
  assert.match(msg, /writer-a/);
  assert.match(msg, /writer-b/);
  assert.equal(context.get('global', 'any', 'k.takeover', false), 'b1', '软约束：写入不被拒绝');
  assert.equal(context.writerOf('k.takeover', false), 'writer-b', '写者章更新为接管者');
});

test('snapshot 附带 writers 映射（可观测）', async () => {
  const snap = context.snapshot(false);
  assert.equal(snap.writers['home.highPower'], 'm7orioe9');
  assert.equal(snap.global['home.highPower'], true, '值仍是裸值（前面用例最后写的是 true）');
  assert.equal(snap.writers['k.one'], 'writer-a');
});
