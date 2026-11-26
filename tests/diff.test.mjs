'use strict';
/* 版本 diff 回归：变更检测 / 行号 / 上下文压缩 / CRLF 归一。
 * 服务端 computeDiff 是 /api/script/:id/diff 的核心，前端只渲染其输出。 */
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { computeDiff } = require('../server/lib/diff');

test('computeDiff：修改行产生成对 del/add，行号只落在各自一侧', () => {
  const d = computeDiff('line1\nold\nline3\n', 'line1\nnew\nline3\n');
  assert.equal(d.changed, true);
  assert.equal(d.removed, 1);
  assert.equal(d.added, 1);
  const del = d.rows.find((r) => r.type === 'del');
  const add = d.rows.find((r) => r.type === 'add');
  assert.equal(del.text, 'old');
  assert.deepEqual([del.oldNo, del.newNo], [2, null]);
  assert.equal(add.text, 'new');
  assert.deepEqual([add.oldNo, add.newNo], [null, 2]);
});

test('computeDiff：内容完全一致返回 changed:false 且无增删行', () => {
  const d = computeDiff('same\ncontent\n', 'same\ncontent\n');
  assert.equal(d.changed, false);
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
});

test('computeDiff：长文件仅保留变更前后 3 行上下文，跳过段用 gap 标记', () => {
  const oldSrc = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
  const newSrc = oldSrc.replace('line15\n', 'CHANGED\n');
  const d = computeDiff(oldSrc, newSrc);
  assert.equal(d.changed, true);
  assert.ok(d.rows.length < 12, '30 行文件不应全量返回');
  assert.ok(d.rows.some((r) => r.type === 'gap' && r.count > 0), '跳过段应标记 count');
  const texts = d.rows.filter((r) => r.text).map((r) => r.text);
  assert.ok(texts.includes('line12') && texts.includes('line18'), '变更点前后 3 行应保留');
  assert.ok(!texts.includes('line1'), '远处上下文应折叠');
});

test('computeDiff：CRLF/LF 混用不产生虚假变更', () => {
  const d = computeDiff('a\r\nb\r\n', 'a\nb\n');
  assert.equal(d.changed, false);
});

test('computeDiff 并排视图：删除/新增配成同一行，字符级段只标真改动', () => {
  const d = computeDiff('const a = 1;\nkeep();\n', 'const a = 2;\nkeep();\n');
  const change = d.allSideRows.find((r) => r.kind === 'change');
  assert.ok(change, '修改行应并排成一行');
  assert.equal(change.left.no, 1);
  assert.equal(change.right.no, 1);
  assert.ok(change.inline.left.some((s) => s.changed && s.text === '1'));
  assert.ok(change.inline.right.some((s) => s.changed && s.text === '2'));
  assert.ok(change.inline.left.every((s) => !s.changed || s.text.length <= 4), '不应把整行都标成改动');
  const ctx = d.allSideRows.find((r) => r.kind === 'ctx');
  assert.deepEqual([ctx.left.text, ctx.right.text], ['keep();', 'keep();']);
});

test('computeDiff 并排视图：纯新增行左侧留空，折叠 gap 保留', () => {
  const oldSrc = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
  const newSrc = oldSrc.replace('l10\n', 'l10\nNEW\n');
  const d = computeDiff(oldSrc, newSrc);
  const add = d.sideRows.find((r) => r.kind === 'add');
  assert.ok(add, '纯新增应单独占一行');
  assert.equal(add.left, null);
  assert.equal(add.right.text, 'NEW');
  assert.ok(d.sideRows.some((r) => r.kind === 'gap' && r.count > 0), '折叠区应跨栏保留');
  assert.equal(d.allSideRows.length, 21, '完整并排行数应为新旧对齐后的总行数');
});
