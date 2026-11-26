'use strict';
/* 上下文单测：影子/正式全局隔离、local 按脚本隔离、落盘文件、ctx.global 白名单。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-context-'));
const config = require('../server/config');
config.DATA = tmpRoot; // 必须在 require context 之前覆盖
const context = require('../server/scripts/context');
const { validateScript } = require('../server/scripts/validate');

test('global 影子与正式隔离', async () => {
  await context.set('global', 'any', 'avoiding', true, false);
  await context.set('global', 'any', 'avoiding', false, true);
  assert.equal(context.get('global', 'any', 'avoiding', false), true);
  assert.equal(context.get('global', 'any', 'avoiding', true), false);
});

test('local 按脚本 + 模式隔离，并支持默认值', async () => {
  await context.set('local', 'avoid', 'since', 123, false);
  await context.set('local', 'schedule', 'since', 456, false);
  await context.set('local', 'avoid', 'since', 789, true);
  assert.equal(context.get('local', 'avoid', 'since', false), 123);
  assert.equal(context.get('local', 'schedule', 'since', false), 456);
  assert.equal(context.get('local', 'avoid', 'since', true), 789);
  assert.equal(context.get('local', 'avoid', 'missing', false, 'fallback'), 'fallback');
});

test('上下文写入落盘 JSON', async () => {
  await context.set('global', 'any', 'pendingStart', true, false);
  const raw = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'context.json'), 'utf8'));
  assert.equal(raw.global.production.pendingStart, true);
  assert.ok(raw.global.shadow);
});

test('snapshot 只返回当前模式命名空间', async () => {
  const prod = context.snapshot(false);
  const shadow = context.snapshot(true);
  assert.equal(prod.global.pendingStart, true);
  assert.equal(shadow.global.pendingStart, undefined);
  assert.equal(shadow.global.avoiding, false);
});

test('validateScript 允许 ctx.global / ctx.local，拒绝裸 global', () => {
  assert.equal(validateScript('await ctx.global.get("k", false); await ctx.local.set("x", 1);'), null);
  const err = validateScript('global.foo = 1;');
  assert.match(String(err), /禁止标识符：global/);
});
