'use strict';
/* MCP 工具公共层（对齐 studio）：
 * - 统一四参注册 (name, desc, shape, handler)，wrapToolActivity 包一层
 * - 每次调用广播 activity / idle，handler 抛错转成文本返回，不打崩会话
 * - text/fail 输出封装，全局只有一个 hub 引用 */
const hub = require('../lib/ws-hub');

function text(s) { return { content: [{ type: 'text', text: String(s) }] }; }
function fail(s) { return { content: [{ type: 'text', text: '错误：' + String(s) }], isError: true }; }

function wrapToolActivity(server) {
  const rawTool = server.tool.bind(server);
  server.tool = (name, desc, shape, cb) => {
    if (typeof cb !== 'function' || typeof shape !== 'object' || shape == null) {
      throw new Error(`工具 ${name} 注册参数不对：统一用 (name, desc, shape, handler) 四参形态`);
    }
    rawTool(name, desc, shape, async (...args) => {
      hub.broadcast({ type: 'mcp', event: 'activity', tool: name, ts: Date.now() });
      try {
        return await cb(...args);
      } catch (e) {
        return fail(e && e.message || e);
      } finally {
        hub.broadcast({ type: 'mcp', event: 'idle', tool: name, ts: Date.now() });
      }
    });
  };
}

module.exports = { text, fail, wrapToolActivity };
