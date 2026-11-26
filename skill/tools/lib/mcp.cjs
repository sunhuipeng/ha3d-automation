'use strict';
/* skill 工具的 MCP 客户端公共层：SSE 地址 / env 覆盖 / 错误码 / close 口径只在此维护一处。
 * 各工具只传 tool 名、参数与可选的 clientName / errorPrefix。 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

async function callTool(name, args, opts = {}) {
  const { clientName = 'ha3d-tool', errorPrefix = 'TOOL_ERROR' } = opts;
  const client = new Client({ name: clientName, version: '1.0.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL(process.env.HA3D_MCP || 'http://127.0.0.1:8100/mcp/sse')));
  try {
    const r = await client.callTool({ name, arguments: args || {} });
    const out = (r.content || []).map((c) => c.text).join('\n');
    if (r.isError) { console.error(errorPrefix + ': ' + out); process.exit(2); }
    console.log(out);
  } finally {
    await client.close();
  }
}

module.exports = { callTool };
