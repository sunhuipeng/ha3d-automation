'use strict';
/* skill 工具的 MCP 客户端公共层：SSE 地址 / env 覆盖 / 错误码 / close 口径只在此维护一处。
 * 各工具只传 tool 名、参数与可选的 clientName / errorPrefix。 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

/* 调用并返回文本结果；工具报错时抛异常（保留原文），由调用方决定怎么呈现。 */
async function callToolText(name, args, opts = {}) {
  const { clientName = 'ha3d-tool' } = opts;
  const client = new Client({ name: clientName, version: '1.0.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL(process.env.HA3D_MCP || 'http://127.0.0.1:8100/mcp/sse')));
  try {
    const r = await client.callTool({ name, arguments: args || {} });
    const out = (r.content || []).map((c) => c.text).join('\n');
    if (r.isError) { const e = new Error(out); e.toolError = true; throw e; }
    return out;
  } finally {
    await client.close();
  }
}

/* 命令行入口的默认口径：成功打印，失败打到 stderr 并 exit 2。 */
async function callTool(name, args, opts = {}) {
  const { errorPrefix = 'TOOL_ERROR' } = opts;
  try {
    console.log(await callToolText(name, args, opts));
  } catch (e) {
    console.error(errorPrefix + ': ' + (e && e.message || e));
    process.exit(2);
  }
}

module.exports = { callTool, callToolText };
