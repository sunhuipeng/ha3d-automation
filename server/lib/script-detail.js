'use strict';
/* 脚本版本详情唯一组装（审计 3.3）：REST GET /api/script/:id 与 MCP
 * automation_get_script_status 共用这一份拼装，消除"同一领域两套数据组装"的漂移面。
 * statusSummary（状态聚合）见 executor；本模块负责版本记录 + 通道/可改标记（+ 可选日志）。
 * logs 仅在传 logLimit 时内联（MCP 需要一次拿全，REST 由前端按需另行拉取）。 */
const { store, executor } = require('./runtime');

function scriptDetail(sid, { version, logLimit } = {}) {
  const rec = store.get(sid, version);
  if (!rec) return null;
  const channel = store.channelOf(rec.meta);
  return {
    ...rec,
    /* status=版本级（该版本实例的运行状态）；scriptStatus=脚本级（列表徽章口径） */
    ...executor.statusSummary(rec.id, rec.version),
    channel,
    /* 便于前端标注"这个版本是工作副本，可直接改" */
    mutable: channel === 'shadow',
    ...(logLimit ? { logs: store.readLogs(rec.id, rec.version, logLimit) } : null),
  };
}

module.exports = { scriptDetail };
