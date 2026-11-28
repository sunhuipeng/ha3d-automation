'use strict';
/* 系统运行态快照唯一实现（审计 2.2/2.3）：REST /api/health 与 MCP automation_get_system_info
 * 共用同一份字段拼装与版本常量，避免两处各自维护漂移。
 * version 取自根 package.json（与镜像 tag 同源，push-image.sh 用同一字段打 tag）——
 * 线上 MCP 返回的版本可与本地仓库 package.json 直接比对，判断 skill 文档/clone 源码是否同版本。
 * connector/executor 由调用方注入（MCP 层传 ctx 里的实例，便于测试 mock）；
 * 只挑安全字段，绝不下发 token / haUrl 等敏感配置。 */
const PKG_VERSION = require('../../package.json').version;
const store = require('../scripts/store');
const { getConfig } = require('../config');

function systemSnapshot(ctx) {
  const { connector, executor } = ctx || {};
  const cfg = getConfig();
  return {
    version: PKG_VERSION,
    devMode: cfg.devMode === true,
    executionMode: cfg.executionMode,
    haStatus: connector ? connector.status : null,
    demo: connector ? connector.demo === true : false,
    scripts: store.list().length,
    running: executor ? executor.runningList().length : 0,
    node: process.version,
    platform: process.platform + '/' + process.arch,
    uptimeSeconds: Math.floor(process.uptime()),
    ts: Date.now(),
  };
}

module.exports = { PKG_VERSION, systemSnapshot };
