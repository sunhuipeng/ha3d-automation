'use strict';
/* 域 3：脚本 —— 列表 / 版本 / 详情 / 提交 / 发布 / 启停 / 清理 / 日志 / 运行态。
 * 版本角色：shadow（影子，至多1）+ production（正式，至多1）+ archive（归档）。 */
const express = require('express');
const { store, executor, connector, hub, validate } = require('../lib/runtime');
const { computeDiff } = require('../lib/diff');
const topology = require('../scripts/topology');

/* 拓扑展示补充（单脚本图 / 全局图共用）：从 HA 连接器的全量实体缓存取 friendly_name，
 * 不额外请求 HA。只作用于接口返回，不污染内存观测数据——HA 侧重命名后下一次刷新即可反映；
 * HA 未就绪 / 实体已删除 / 没有 friendly_name 时不生成映射，前端回退显示实体 ID。 */
function entityLabelsFor(ids) {
  const entityLabels = {};
  for (const id of ids) {
    const name = connector.getState(id)?.attributes?.friendly_name;
    if (name && name !== id) entityLabels[id] = { name, label: `${name}（${id}）` };
  }
  return entityLabels;
}

/* 全量脚本名映射（两处共用）：跨脚本 call/taskDep 边的目标脚本节点用它显示友好名 */
function scriptNamesMap() {
  return Object.fromEntries(store.list().map((s) => [String(s.id), s.name || String(s.id)]));
}

function topologyForDisplay(sid) {
  const result = topology.get(sid);
  const ids = new Set();
  for (const group of Object.values(result.topology || {})) {
    for (const id of [...(group.reads || []), ...(group.writes || [])]) ids.add(String(id));
  }
  return { ...result, entityLabels: entityLabelsFor(ids), scriptNames: scriptNamesMap() };
}

/* 全局拓扑展示：只取每个脚本的正式（production）通道——用户口径：全局图只看正式运行态。
 * 补脚本名（左侧列表同源）与覆盖所有脚本的实体展示名；两者都不落盘，仅作用于接口返回。
 * 只有影子、还没正式发布过的脚本不出现在全局图里（符合"只画正式"口径）。
 * 空组（发布后待观测/版本重置）不返回：图上只画"当前版本已观测到的事实"，
 * 该脚本会从全局图消失一段时间，跑起来后重新长出。 */
function topologyForGlobalDisplay() {
  const all = topology.all();
  const names = new Map(store.list().map((s) => [String(s.id), s.name || String(s.id)]));
  const scripts = {};
  const ids = new Set();
  for (const [sid, byMode] of Object.entries(all.scripts || {})) {
    const group = byMode && byMode.production;
    if (!group) continue;
    const hasData = (group.reads?.length || group.writes?.length
      || group.contextReads?.length || group.contexts?.length
      || group.calls?.length || group.taskDeps?.length) ? true : false;
    if (!hasData) continue;
    /* running：该版本有正式实例在跑（发布/停止后为 false，节点据此淡化显示） */
    const prodRun = executor.runningVersions(sid).find((r) => r.mode === 'production');
    scripts[sid] = {
      ...group,
      name: names.get(sid) || sid,
      running: !!prodRun && Number(prodRun.version) === Number(group.version),
    };
    for (const id of [...(group.reads || []), ...(group.writes || [])]) ids.add(String(id));
  }
  return { updatedAt: all.updatedAt, scripts,
    entityLabels: entityLabelsFor(ids),
    scriptNames: Object.fromEntries(names) };
}

module.exports = function scriptRoutes() {
  const r = express.Router();

  /* 列表：合并运行时真相 —— latestVersion（最新提交）/ productionVersion（线上）/
   * runningVersions（真正在跑的实例，正式与影子各至多一个）三者必须分开暴露。 */
  r.get('/scripts', (req, res) => res.json(
    store.list().map((s) => {
      const rvs = executor.runningVersions(s.id);
      /* 运行状态由 executor 内存合成（meta.json 已不存 status）：running / paused / error / stopped */
      return { ...s, status: executor.scriptRuntimeStatus(s.id), runningVersion: executor.runningVersion(s.id), runningVersions: rvs };
    }),
  ));

  /* 动作与场景候选列表（只给 Home 编辑页勾选用，只读）。
   * 口径：一次性脚本/场景（kind=script/scene），含影子候选——本地 dev 环境迁移项多为影子，
   * 让编辑页能先配好展示项；triggerable 标出是否有正式版（触发接口只认正式版）。
   * 不返回 script 正文、运行实例等管理信息：这是跨项目的最小只读面。 */
  r.get('/actions', (req, res) => {
    const items = store.list().filter((s) => s.kind !== 'automation').map((s) => ({
      id: s.id,
      name: s.name || s.id,
      kind: s.kind || 'automation',
      description: s.description || '',
      icon: s.icon || null,
      /* Home 侧用 svg 字段名存 SVG 源码（与自己的 mdi icon 字段区分），这里同源双写 */
      svg: s.icon || null,
      productionVersion: s.productionVersion || null,
      shadowVersion: s.shadowVersion || null,
      triggerable: !!s.productionVersion,
    }));
    res.json({ items });
  });

  /* 版本列表（含角色/运行状态/时间），供前端版本管理。
   * status 由 executor 内存合成（running/paused/error/stopped），meta.json 已不存。 */
  r.get('/script/:id/versions', (req, res) => res.json({
    scriptId: req.params.id,
    shadowVersion: store.versionOfChannel(req.params.id, 'shadow'),
    productionVersion: store.versionOfChannel(req.params.id, 'production'),
    runningVersion: executor.runningVersion(req.params.id),
    runningVersions: executor.runningVersions(req.params.id),
    versions: store.detailedVersions(req.params.id).map((v) => ({
      ...v,
      status: executor.versionRuntimeStatus(req.params.id, v.version),
    })),
  }));

  /* 版本 diff：服务端读两份落盘 script.js 计算，前端只渲染。
   * from/to 为显式版本号；缺省时自动取当前正式 → 当前影子。
   * 用于右侧“对比变更”按钮（影子与正式并存时展示）。 */
  r.get('/script/:id/diff', (req, res) => {
    const from = req.query.from != null ? Number(req.query.from) : store.versionOfChannel(req.params.id, 'production');
    const to = req.query.to != null ? Number(req.query.to) : store.versionOfChannel(req.params.id, 'shadow');
    const a = from != null ? store.get(req.params.id, from) : null;
    const b = to != null ? store.get(req.params.id, to) : null;
    if (!a || !b) return res.status(404).json({ error: '对比版本不存在（需明确指定存在的 from/to 版本号）' });
    const result = computeDiff(a.script, b.script);
    res.json({
      scriptId: req.params.id,
      from, to,
      fromChannel: store.channelOf(a.meta),
      toChannel: store.channelOf(b.meta),
      ...result,
    });
  });

  r.get('/script/:id', (req, res) => {
    const rec = store.get(req.params.id, req.query.version ? Number(req.query.version) : undefined);
    if (!rec) return res.status(404).json({ error: '脚本版本不存在' });
    // script 正文只用于前端只读源码预览；执行仍以服务端落盘的 script.js 为准
    res.json({
      ...rec,
      /* meta.json 已不存 status：运行状态由 executor 内存合成。
       * status 是版本级（当前打开版本的徽章）；scriptStatus 是脚本级（左侧列表徽章口径，
       * 任一实例在跑 → running，无实例但最近异常退出 → error）——两者口径不同，
       * 前端回填列表必须用 scriptStatus，用版本级会把脚本级 error 徽标遮蔽成 stopped。 */
      status: executor.versionRuntimeStatus(rec.id, rec.version),
      scriptStatus: executor.scriptRuntimeStatus(rec.id),
      running: executor.isRunning(rec.id),
      runningVersion: executor.runningVersion(rec.id),
      runningVersions: executor.runningVersions(rec.id),
      /* 便于前端标注"这个版本是工作副本，可直接改" */
      mutable: store.channelOf(rec.meta) === 'shadow',
    });
  });

  /* 运行时拓扑：executor 在真实拦截点观测到的实体读写与上下文写入，
   * 按 shadow/production 分组。数据是"运行一段时间后才逐步完整"的，前端要标注这一点。
   * 脚本没跑过则为空对象 {}，不是错误。 */
  r.get('/script/:id/topology', (req, res) => res.json(topologyForDisplay(req.params.id)));

  r.post('/scripts', (req, res) => {
    try {
      /* dryRun / longRunning 是旧参数：语义分别由 channel / kind 派生，此处不再透传（传入即忽略） */
      const { scriptId, name, script, flow, description, newVersion, channel, icon, kind, runnerTimeoutMs, restartable } = req.body || {};
      const err = validate(script);
      if (err) return res.status(400).json({ error: '脚本校验未通过：' + err });
      const rec = executor.submitScript(scriptId, { name, script, flow, description, newVersion, channel, icon, kind, runnerTimeoutMs, restartable });
      executor.broadcastRefresh(['scripts', 'script'], { scriptId: rec.id, version: rec.version });
      res.json({ ok: true, id: rec.id, version: rec.version, overwritten: !!rec.overwritten });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  r.post('/script/:id/start', (req, res) => {
    try {
      executor.start(req.params.id, req.body && req.body.version, connector);
      hub.broadcast({ type: 'refresh', what: 'scripts' });
      res.json({ ok: true, running: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  /* 一次性触发（Home 面板 / 场景入口 / 管理页）：
   * body.channel='shadow' 触发影子版本（写操作被执行器硬拦截只记日志，不改 HA 实体）；
   * 缺省只认正式版本；只认短脚本。dev 模式下设备写另由 devMode 闸拦截。 */
  r.post('/script/:id/trigger', (req, res) => {
    try {
      const ch = req.body && req.body.channel === 'shadow' ? 'shadow' : undefined;
      const result = executor.trigger(req.params.id, connector, ch);
      res.json({ ok: true, ...result });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  r.post('/script/:id/stop', (req, res) => {
    /* body.version 可选：给则只停该版本实例，不给停全部（正式+影子） */
    const v = req.body && req.body.version ? Number(req.body.version) : undefined;
    const ok = executor.stop(req.params.id, 'manual', v);
    hub.broadcast({ type: 'refresh', what: 'scripts' });
    res.json({ ok, running: executor.isRunning(req.params.id), runningVersions: executor.runningVersions(req.params.id) });
  });

  /* 发布影子版本为正式版本：{ version?, autoSwitch? }；省略版本则取当前影子。
   * 运行中是另一个版本时默认自动切换实例（停旧启新，失败回退）；autoSwitch=false 则严格报错。
   * 若发布的正是运行中的影子版本，则同版本热切为真实下发。 */
  r.post('/script/:id/publish', (req, res) => {
    try {
      const body = req.body || {};
      const version = body.version ? Number(body.version) : undefined;
      const result = executor.publish(req.params.id, version, { autoSwitch: body.autoSwitch !== false });
      res.json({ ok: true, ...result });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  /* 回滚：读历史版本（正式/归档）内容 → 作为新版本提交（shadow）。
   * 刻意不自动发布：回滚同样要走"影子验证 → 显式发布"的门禁。 */
  r.post('/script/:id/rollback', (req, res) => {
    try {
      const from = req.body && req.body.fromVersion ? Number(req.body.fromVersion) : null;
      if (!from) return res.status(400).json({ error: '缺少 fromVersion（要回滚到的历史版本号）' });
      const rec = executor.rollback(req.params.id, from);
      executor.broadcastRefresh(['scripts', 'script'], { scriptId: rec.id, version: rec.version });
      res.json({
        ok: true, id: rec.id, version: rec.version,
        fromVersion: rec.fromVersion, fromChannel: rec.fromChannel,
        description: rec.meta.description,
      });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  /* 清理版本：禁止删除正在运行的版本 */
  r.delete('/script/:id/version/:version', (req, res) => {
    try {
      const result = executor.removeVersion(req.params.id, Number(req.params.version));
      res.json({ ok: true, ...result });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  /* 删除整个脚本（全部版本）：有实例在运行即拒绝，前端只在停止状态展示删除按钮 */
  r.delete('/script/:id', (req, res) => {
    try {
      const result = executor.removeScript(req.params.id);
      res.json({ ok: true, ...result });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  r.get('/script/:id/logs', (req, res) => {
    const v = req.query.version ? Number(req.query.version) : (store.listVersions(req.params.id).slice(-1)[0]);
    /* 默认只返回最近 100 行，避免打开面板时全量拉取；可用 ?limit= 覆盖 */
    res.json({ scriptId: req.params.id, version: v || null, logs: store.readLogs(req.params.id, v, Number(req.query.limit) || 100) });
  });

  /* 全局运行拓扑：只汇总正式通道；前端全局视图手动拉取，不定时刷新 */
  r.get('/topology/all', (req, res) => res.json(topologyForGlobalDisplay()));

  return r;
};

/* 暴露给测试：验证展示名映射不会污染原始拓扑数据 */
module.exports.topologyForDisplay = topologyForDisplay;
module.exports.topologyForGlobalDisplay = topologyForGlobalDisplay;
