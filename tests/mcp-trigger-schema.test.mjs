import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildTools } from '../server/mcp/tools.js';

/* 抓 automation_trigger_script 注册时的 zod shape，锁定入参契约：
 * scriptId + confirmed 必传，channel 只认 production/shadow（缺省=production） */
function triggerSchema() {
  const shapes = {};
  const server = { tool: (name, _desc, shape) => { shapes[name] = shape; } };
  buildTools(server, { connector: {}, executor: {} });
  return z.object(shapes['automation_trigger_script']);
}

test('MCP trigger_script：缺省通道（仅 scriptId+confirmed）通过', () => {
  assert.doesNotThrow(() => triggerSchema().parse({ scriptId: 'abc12345', confirmed: true }));
});

test('MCP trigger_script：channel=shadow 通过，非法通道被拒', () => {
  assert.doesNotThrow(() => triggerSchema().parse({ scriptId: 'abc12345', channel: 'shadow', confirmed: true }));
  assert.doesNotThrow(() => triggerSchema().parse({ scriptId: 'abc12345', channel: 'production', confirmed: true }));
  assert.throws(() => triggerSchema().parse({ scriptId: 'abc12345', channel: 'bogus', confirmed: true }));
});

test('MCP trigger_script：缺 confirmed 或 scriptId 被拒', () => {
  assert.throws(() => triggerSchema().parse({ scriptId: 'abc12345' }));
  assert.throws(() => triggerSchema().parse({ confirmed: true }));
});
