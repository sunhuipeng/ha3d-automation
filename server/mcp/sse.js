'use strict';
/* MCP over SSE：GET /mcp/sse 建连，POST /mcp/messages 回传 JSON-RPC。
 * 每个 SSE 会话独立 McpServer；会话数交给 hub 让前端横条补发 connected。 */
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { buildTools } = require('./tools');
const hub = require('../lib/ws-hub');
/* MCP serverInfo 版本与 package.json / 镜像 tag 同源，避免硬编码漂移（历史上曾停在 0.1.0）。 */
const PKG_VERSION = require('../../package.json').version;

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
    sessions.set(transport.sessionId, { transport, server, openedAt: Date.now() });
    hub.broadcast({ type: 'mcp', event: 'connected', sessions: sessions.size, ts: Date.now() });
    res.on('close', () => {
      sessions.delete(transport.sessionId);
      try { server.close(); } catch (e) {}
      hub.broadcast({ type: 'mcp', event: 'disconnected', sessions: sessions.size, ts: Date.now() });
    });
    try { await server.connect(transport); }
    catch (e) {
      sessions.delete(transport.sessionId);
      console.error('[mcp] SSE 初始化失败:', e.message);
      try { res.end(); } catch (err) {}
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
