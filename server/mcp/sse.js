'use strict';
/* MCP over SSE：GET /mcp/sse 建连，POST /mcp/messages 回传 JSON-RPC。
 * 每个 SSE 会话独立 McpServer；会话数交给 hub 让前端横条补发 connected。 */
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { buildTools } = require('./tools');
const hub = require('../lib/ws-hub');
/* MCP serverInfo 版本与 package.json / 镜像 tag 同源（system-info 唯一定义），避免硬编码漂移。 */
const { PKG_VERSION } = require('../lib/system-info');

const sessions = new Map(); // sessionId -> { transport, server, openedAt }

function mountMcpSse(app, ctx) {
  hub.setMcpSessions(() => sessions.size);

  app.get('/mcp/sse', async (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const server = new McpServer({ name: 'ha3d-automation', version: PKG_VERSION });
    buildTools(server, ctx);
    const transport = new SSEServerTransport('/mcp/messages', res);
    /* connected 广播与 sessions 注册放在 connect 成功之后（审计 4.8）：
     * 之前先广播再 connect，初始化失败时前端会先看到"已连接"再"断开"的假状态抖动。 */
    let registered = false;
    res.on('close', () => {
      /* 幂等清理：close 可能由初始化失败的 res.end() 或正常断开触发，只广播一次 */
      if (!sessions.delete(transport.sessionId) && !registered) return;
      try { server.close(); } catch (e) {}
      hub.broadcast({ type: 'mcp', event: 'disconnected', sessions: sessions.size, ts: Date.now() });
    });
    try {
      await server.connect(transport);
      registered = true;
      sessions.set(transport.sessionId, { transport, server, openedAt: Date.now() });
      hub.broadcast({ type: 'mcp', event: 'connected', sessions: sessions.size, ts: Date.now() });
    } catch (e) {
      console.error('[mcp] SSE 初始化失败:', e.message);
      try { res.end(); } catch (err) {} // 触发上面的 close → 幂等清理
    }
  });

  app.post('/mcp/messages', async (req, res) => {
    const sid = String(req.query.sessionId || '');
    const s = sessions.get(sid);
    if (!s) return res.status(404).json({ error: 'unknown mcp session: ' + sid });
    try { await s.transport.handlePostMessage(req, res, req.body); }
    catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
  });

  app.get('/mcp/health', (req, res) => {
    res.json({ ok: true, sessions: sessions.size, frontends: hub.listFrontends() });
  });
}

module.exports = { mountMcpSse };
