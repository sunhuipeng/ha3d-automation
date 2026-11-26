'use strict';
/* 域 1：系统 —— 健康检查 / HA 连接状态。 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { connector, store, executor } = require('../lib/runtime');
const { publicConfig, saveConfig, getConfig } = require('../config');

module.exports = function systemRoutes() {
  const r = express.Router();

  r.get('/health', (req, res) => {
    res.json({ ok: true, ts: Date.now(), ha: connector.status, demo: connector.demo, devMode: getConfig().devMode === true, scripts: store.list().length, running: executor.runningList().length });
  });

  /* HA 连接配置：token 只回传是否已配置，不回传明文 */
  r.get('/config', (req, res) => res.json(publicConfig()));

  r.put('/config', (req, res) => {
    try {
      const cfg = saveConfig(req.body || {});
      connector.restart();
      res.json({ ok: true, config: cfg });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  /* MCP 接入配置：弹窗展示 / 复制这份 JSON，粘到 WorkBuddy 直接生效。
   * 地址服务端拼：主机名取请求 Host，端口用启动端口（PORT 环境变量改过也对）；
   * dev=1（Vite 页只有 /api 被代理）时换成本服务端口。对齐 studio 的做法。 */
  r.get('/mcp-config', (req, res) => {
    const port = getConfig().port;
    const dev = req.query.dev === '1';
    /* L4：反代场景优先信任 X-Forwarded-*，Host 无端口时不再硬拼本地端口，
     * 避免生成 https://host:8100/... 这种连不上的 URL。 */
    const xfProto = req.headers['x-forwarded-proto'];
    const xfHost = req.headers['x-forwarded-host'];
    const proto = String(xfProto || req.protocol || 'http').split(',')[0].trim();
    let host = String(xfHost || req.headers.host || '').split(',')[0].trim();
    if (dev) {
      // 仅 Vite 开发代理时补本地服务端口
      const bare = host.replace(/:\d+$/, '') || 'localhost';
      host = `${bare}:${port}`;
    }
    if (!host) host = `localhost:${port}`;
    const url = `${proto}://${host}/mcp/sse`;
    res.json({
      ok: true, port, url,
      config: { mcpServers: { ha3d_automation: { type: 'sse', url } } },
    });
  });

  /* skill 压缩包下载：Docker 构建阶段把 skill/ 打成 /app/skill.zip（见 Dockerfile，
   * 排除 .cache），弹层"下载 skill 压缩包"直接取走给 Agent 安装。
   * 开发环境没有压缩包 → 返回失败提示（不即时打包，保持服务端零打包依赖）。 */
  r.get('/skill-package', (req, res) => {
    const zipPath = process.env.HA3D_SKILL_ZIP || path.join(__dirname, '../../skill.zip');
    if (!fs.existsSync(zipPath)) {
      return res.status(404).json({
        ok: false,
        error: 'skill 压缩包未打包：仅 Docker 镜像内置（构建阶段生成 /app/skill.zip）；开发环境请直接使用仓库 skill/ 目录',
      });
    }
    res.download(zipPath, 'ha3d-automation-skill.zip');
  });

  return r;
};
