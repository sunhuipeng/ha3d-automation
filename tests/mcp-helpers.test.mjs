import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { text, fail, wrapToolActivity } = require('../server/mcp/helpers.js');

test('text：包成 MCP 文本块', () => {
  const r = text('hello');
  assert.equal(r.content[0].type, 'text');
  assert.equal(r.content[0].text, 'hello');
});

test('fail：带 isError 标记', () => {
  const r = fail('出错了');
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /出错了/);
});

test('wrapToolActivity：强制四参形态，传函数当 shape 时报错', () => {
  const fake = { tool() {} };
  wrapToolActivity(fake);
  assert.throws(() => fake.tool('x', 'desc', () => {}), /四参/);
});
