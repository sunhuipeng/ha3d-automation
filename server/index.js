'use strict';
/* ha3d-automation 服务入口：npm start → http://localhost:8100
 * 只做组装；API 按域拆在 routes/，共享实例在 lib/runtime.js，MCP 在 mcp/。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { getConfig, ensureDataDir, ROOT } = require('./config');
const systemRoutes = require('./routes/system');
const scriptRoutes = require('./routes/scripts');
const { attach: attachHub } = require('./lib/ws-hub');
const { mountMcpSse } = require('./mcp/sse');
const runtime = require('./lib/runtime');

const cfg = getConfig();
ensureDataDir();
/* 运行状态不再写 meta.json（2026-11-26）：running/paused/error 由 executor 内存判定，
 * 重启恢复意图清单在 data/runtime/desired-running.json（run-state），启动无需自愈。 */

/* 运行时日志定时清理：孤儿日志删除 + 超限截断（单文件 >2MB 保留尾部 512KB）。
 * 启动时跑一次，之后每 6 小时一次；unref 不阻止进程退出。 */
{
  const clean = () => {
    try {
      const { truncated, removed } = runtime.store.cleanupRuntimeLogs();
      if (truncated || removed) console.log(`[runtime-log] 清理完成：截断 ${truncated} 个，删除孤儿 ${removed} 个`);
    } catch (e) { console.error('[runtime-log] 清理失败：', e.message); }
  };
  clean();
  setInterval(clean, 6 * 3600 * 1000).unref();
}

const app = express();
app.use(express.json({ limit: '2mb' }));

/* 按域挂载（同 studio 口径）：routes/ 下每个文件自带 Router，零参工厂。
 *   system.js   /api/health、/api/ha-status
 *   scripts.js  /api/scripts…（列表 / 提交 / 启停 / 日志 / 运行态） */
const api = express.Router();
api.use(systemRoutes());
api.use(scriptRoutes());
app.use('/api', api);

mountMcpSse(app, runtime.mcpCtx);

/* 静态前端 = Vue 构建产物 client/dist（npm run client:build 生成） */
const CLIENT_DIST = path.join(ROOT, 'client', 'dist');
const hasDist = fs.existsSync(path.join(CLIENT_DIST, 'index.html'));
app.use(express.static(CLIENT_DIST, { etag: true }));

const server = http.createServer(app);
attachHub(server);

server.listen(cfg.port, () => {
  console.log(`ha3d-automation → http://localhost:${cfg.port}`);
  console.log(`HA: ${cfg.haUrl || '(未配置，demo 模式)'}`);
  console.log(`MCP(SSE) → http://localhost:${cfg.port}/mcp/sse`);
  if (!hasDist) console.warn('⚠ 未找到 client/dist，请先 npm run client:build');
  runtime.startConnector();
  runtime.restoreOnReady(); // 连接器就绪后按运行意图清单恢复脚本（含版本）
});

function shutdown() {
  runtime.executor.stopAll();
  runtime.connector.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server };
