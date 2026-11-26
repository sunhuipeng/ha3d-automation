#!/usr/bin/env node
/* 通用 MCP 工具调用器（ha3d-automation）
 * 用法: node skill/tools/mcp-call.cjs <tool> ['{json 参数}']
 * 示例: node skill/tools/mcp-call.cjs automation_list_scripts
 *       node skill/tools/mcp-call.cjs automation_submit_script "$(cat /tmp/payload.json)"
 * 依赖本项目 @modelcontextprotocol/sdk，SSE 地址 http://127.0.0.1:8100/mcp/sse */
'use strict';
const { callTool } = require('./lib/mcp.cjs');

(async () => {
  const [tool, argsJson] = process.argv.slice(2);
  if (!tool) { console.error('用法: node skill/tools/mcp-call.cjs <tool> [json-args]'); process.exit(1); }
  await callTool(tool, argsJson ? JSON.parse(argsJson) : {}, { clientName: 'migration-helper' });
})().catch((e) => { console.error('ERR ' + (e && e.message || e)); process.exit(1); });
