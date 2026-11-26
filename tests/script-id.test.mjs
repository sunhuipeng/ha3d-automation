'use strict';
/* 脚本 id 规则：纯小写字母 + 数字的短码；不传 id 时自动生成；重复生成不撞已有目录。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-id-'));
const config = require('../server/config');
config.DATA = tmpRoot;
const store = require('../server/scripts/store');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };

test('newScriptId 是 8 位纯小写字母 + 数字', () => {
  for (let i = 0; i < 50; i++) {
    const id = store.newScriptId();
    assert.match(id, /^[a-z0-9]{8}$/, 'id 应只含小写字母和数字：' + id);
  }
});

test('newScriptId 不会与已有脚本目录重名', () => {
  const taken = store.newScriptId();
  fs.mkdirSync(path.join(tmpRoot, 'scripts', taken), { recursive: true });
  for (let i = 0; i < 50; i++) assert.notEqual(store.newScriptId(), taken);
});

test('submit 不传 id 自动生成，并用该 id 建版本', () => {
  const rec = store.submit(undefined, { name: '自动 id 脚本', script: 'ctx.log("info","hi");', flow: FLOW });
  assert.match(rec.id, /^[a-z0-9]{8}$/);
  assert.equal(rec.version, 1);
  assert.equal(rec.meta.id, rec.id);
  assert.ok(fs.existsSync(path.join(tmpRoot, 'scripts', rec.id, 'v1', 'meta.json')));
});

test('submit 传入已有 id：默认原地修改当前影子（版本号不变）', () => {
  const rec = store.submit(undefined, { name: '复用 id', script: 'ctx.log("info","a");', flow: FLOW });
  const again = store.submit(rec.id, { name: '复用 id', script: 'ctx.log("info","b");', flow: FLOW });
  assert.equal(again.id, rec.id);
  assert.equal(again.version, 1);
  assert.equal(again.meta.revision, 2);
  assert.equal(store.list().filter((s) => s.id === rec.id).length, 1);
  // 想另起候选版才 newVersion
  const branched = store.submit(rec.id, { name: '复用 id', script: 'ctx.log("info","c");', flow: FLOW, newVersion: true });
  assert.equal(branched.version, 2);
});
