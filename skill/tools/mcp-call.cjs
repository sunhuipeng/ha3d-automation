#!/usr/bin/env node
/* 通用 MCP 工具调用器（ha3d-automation）
 * 用法: node skill/tools/mcp-call.cjs <tool> ['{json 参数}']
 * 示例: node skill/tools/mcp-call.cjs automation_list_scripts
 *       node skill/tools/mcp-call.cjs automation_submit_script "$(cat /tmp/payload.json)"
 * 依赖本项目 @modelcontextprotocol/sdk，SSE 地址 http://127.0.0.1:8100/mcp/sse */
'use strict';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const [tool, argsJson] = process.argv.slice(2);
  if (!tool) { console.error('用法: node skill/tools/mcp-call.cjs <tool> [json-args]'); process.exit(1); }
  const client = new Client({ name: 'migration-helper', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL(process.env.HA3D_MCP || 'http://127.0.0.1:8100/mcp/sse')));
  try {
    const r = await client.callTool({ name: tool, arguments: argsJson ? JSON.parse(argsJson) : {} });
    const out = (r.content || []).map((c) => c.text).join('\n');
    if (r.isError) { console.error('TOOL_ERROR: ' + out); process.exit(2); }
    console.log(out);
  } finally {
    await client.close();
  }
})().catch((e) => { console.error('ERR ' + (e && e.message || e)); process.exit(1); });
