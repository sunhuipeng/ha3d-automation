import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildTools } from '../server/mcp/tools.js';

/* 抓 automation_submit_script 注册时的 zod shape，验证服务端 MCP 层确实放行 announce */
function submitSchema() {
  const shapes = {};
  const server = { tool: (name, _desc, shape) => { shapes[name] = shape; } };
  buildTools(server, { connector: {}, executor: {} });
  return z.object(shapes['automation_submit_script']);
}

const payload = (type) => ({
  script: 'ctx.log("x")',
  flow: { version: 1, nodes: [{ id: 'n_ann', type, label: '播报：热水器开起啦，主人' }], edges: [] },
  confirmed: true,
});

test('MCP submit_script：播报节点 type=announce 通过校验', () => {
  assert.doesNotThrow(() => submitSchema().parse(payload('announce')));
});

test('MCP submit_script：未知节点类型仍被拒', () => {
  assert.throws(() => submitSchema().parse(payload('foo')));
});
