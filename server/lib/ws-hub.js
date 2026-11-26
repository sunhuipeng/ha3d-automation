'use strict';
/* 前端 WS 广播（对齐 studio 的 ws-hub，简化版）
 * 本项目执行在服务端，不向前端下 tool 指令、也不收 tool_result；前端只收广播：
 *   { type:'mcp', event:'connected'|'disconnected'|'activity'|'idle', ... }
 *   { type:'refresh', what:'scripts'|'script'|'versions'|'logs', scriptId?, version? }
 *                                                                  ← 前端 ws-client 消费的完整集合；
 *                                                                     scriptId/version 可选，提交影子后前端据此切到新版本详情
 *   { type:'script', event:'status'|'log', ... }                    ← 脚本运行态 / 日志
 *   { type:'select', scriptId, version }                            ← MCP 切换前端选中项
 * MCP 会话数由 mcp/sse.js 提供取值函数：前端新连上时若 MCP 已在会话中，补发 connected。 */
const { WebSocketServer } = require('ws');

const clients = new Set();
let mcpSessionsFn = null;
let seq = 0;

function setMcpSessions(fn) { mcpSessionsFn = fn; }
function mcpSessions() {
  try { return Number(mcpSessionsFn && mcpSessionsFn()) || 0; } catch (e) { return 0; }
}

function send(ws, obj) {
  if (!ws || ws.readyState !== 1) return false;
  try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
}

function broadcast(payload) {
  let n = 0;
  for (const ws of clients) if (send(ws, payload)) n += 1;
  return n;
}

function attach(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (ws) => {
    ws._cid = 'f' + (++seq);
    clients.add(ws);
    send(ws, { type: 'welcome', clientId: ws._cid, ts: Date.now() });
    const n = mcpSessions();
    if (n > 0) send(ws, { type: 'mcp', event: 'connected', sessions: n, ts: Date.now() });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
  return wss;
}

function listFrontends() { return [...clients].map((ws) => ({ id: ws._cid })); }

module.exports = { attach, broadcast, setMcpSessions, listFrontends };
