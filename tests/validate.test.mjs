import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScript } from '../server/scripts/validate.js';

test('validateScript：合法 ctx 白名单脚本通过', () => {
  const src = `
    const s = await ctx.ha.entity('light.living');
    ctx.log('info', 'state=' + (s && s.state));
    ctx.ha.change('light.living', (state) => { ctx.log('info', state); });
    await ctx.sleep(100);
  `;
  assert.equal(validateScript(src), null);
});

test('validateScript：require 被拒绝', () => {
  const err = validateScript("const fs = require('fs');");
  assert.match(err, /禁止标识符：require/);
});

test('validateScript：动态 import 被拒绝', () => {
  assert.match(validateScript("await import('fs');"), /动态 import/);
});

test('validateScript：process / globalThis 被拒绝', () => {
  assert.match(validateScript('process.exit(0);'), /process/);
  assert.match(validateScript('globalThis.x = 1;'), /globalThis/);
});

test('validateScript：eval / Function 被拒绝', () => {
  assert.match(validateScript("eval('1+1')"), /eval/);
  assert.match(validateScript("new Function('return 1')"), /Function/);
});

test('validateScript：网络 API 被拒绝', () => {
  assert.match(validateScript("fetch('http://x')"), /fetch/);
  assert.match(validateScript('new WebSocket("ws://x")'), /WebSocket/);
});

test('validateScript：模块成员访问被拒绝', () => {
  assert.match(validateScript('fs.readFileSync("/etc/passwd")'), /fs/);
});

test('validateScript：语法错误有提示', () => {
  assert.match(validateScript('const = ;'), /语法错误/);
});
