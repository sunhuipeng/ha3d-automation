'use strict';
/* MCP 工具：只读 15 个 + 受控写 8 个 + 面板控制 2 个（切换选中/刷新面板），共 25 个。
 * 版本模型：shadow（工作副本，可原地反复修改）→ production（不可变，真实下发）→ archive（不可变，分 published/discarded）。
 * 只读里含 5 个 HA 自动规划迁移工具（list automations / get config / list scripts / get script config / resolve entities）。
 * ctx = { connector, executor, hub }
 * 所有工具四参注册，wrapToolActivity 统一包活动广播 + 错误兜底。 */
const { z } = require('zod');
const { text, fail, wrapToolActivity } = require('./helpers');
const store = require('../scripts/store');
const context = require('../scripts/context');
const { validateScript } = require('../scripts/validate');

function buildTools(server, ctx) {
  const { connector, executor } = ctx;
  wrapToolActivity(server);

  /* ---------------- 只读 ---------------- */
  server.tool(
    'automation_list_entities',
    '列出 HA 实体（可按 entity_id 或 friendly_name 过滤）。返回只读快照，不含 token。',
    { filter: z.string().optional().describe('过滤关键字') },
    async ({ filter }) => {
      const list = connector.listEntities(filter);
      return text(JSON.stringify({ count: list.length, entities: list.slice(0, 200) }, null, 2));
    }
  );

  server.tool(
    'automation_get_state',
    '查询单个 HA 实体的当前状态与属性。HA 断线/未就绪时明确报"HA 未就绪"（不是实体不存在），避免误判实体被删。',
    { entityId: z.string().describe('实体 id，如 light.living') },
    async ({ entityId }) => {
      /* getState 在断线/回填中也返回 null——用 entityStatus 三态区分，别把断线当"实体不存在" */
      const st = typeof connector.entityStatus === 'function' ? connector.entityStatus(entityId) : null;
      if (st === 'unknown') return fail('HA 未就绪（断线或缓存回填中），无法查询实体状态：' + entityId);
      const s = connector.getState(entityId);
      return s ? text(JSON.stringify(s, null, 2)) : fail('实体不存在：' + entityId);
    }
  );

  server.tool(
    'automation_list_services',
    '列出 HA 可用的域与服务（供生成脚本时确认服务名）。',
    {},
    async () => text(JSON.stringify(connector.services || {}, null, 2).slice(0, 20000))
  );

  server.tool(
    'automation_get_history',
    '查询实体历史（走 HA history/history_during_period）。返回 {eid:[{s,t}]}。',
    { entityId: z.string(), hours: z.number().min(1).max(720).optional().describe('最近 N 小时，默认 24') },
    async ({ entityId, hours }) => {
      const data = await connector.historyOf(entityId, hours || 24);
      return text(JSON.stringify(data, null, 2).slice(0, 30000));
    }
  );

  server.tool(
    'automation_list_scripts',
    '列出脚本仓库中的脚本。每行含 latestVersion（最新提交）/ shadowVersion（影子，可改）/ productionVersion（正式，线上）/ status（脚本级运行状态：running/paused/error/stopped，与 REST /api/scripts 同口径）/ runningVersion（真正在跑的实例）/ shadowRevision（影子改过几次）。',
    {},
    async () => text(JSON.stringify(
      store.list().map((s) => ({
        ...s,
        status: executor.scriptRuntimeStatus(s.id),
        runningVersion: executor.runningVersion(s.id),
        runningVersions: executor.runningVersions(s.id),
      })), null, 2,
    ))
  );

  server.tool(
    'automation_get_script_status',
    '查询某脚本版本的元数据、运行状态与最近日志。返回 channel（shadow/production/archive）、mutable（是否可改）、runningVersion（实例真正在跑的版本）。',
    { scriptId: z.string(), version: z.number().int().positive().optional(), logLimit: z.number().int().min(1).max(1000).optional() },
    async ({ scriptId, version, logLimit }) => {
      const rec = store.get(scriptId, version);
      if (!rec) return fail('脚本版本不存在：' + scriptId + (version ? ' v' + version : ''));
      const logs = store.readLogs(scriptId, rec.version, logLimit || 100);
      const channel = store.channelOf(rec.meta);
      return text(JSON.stringify({
        id: rec.id, version: rec.version, meta: rec.meta, flow: rec.flow,
        channel, mutable: channel === 'shadow',
        /* status=版本级（该版本实例的运行状态）；scriptStatus=脚本级（列表徽章口径） */
        status: executor.versionRuntimeStatus(scriptId, rec.version),
        scriptStatus: executor.scriptRuntimeStatus(scriptId),
        running: executor.isRunning(scriptId), runningVersion: executor.runningVersion(scriptId),
        runningVersions: executor.runningVersions(scriptId),
        logs,
      }, null, 2));
    }
  );

  server.tool(
    'automation_get_logs',
    '读取脚本运行日志（结构化 JSON 行）。影子与正式实例的日志按版本分文件：用 mode 直接指定读影子（shadow，只记日志不下发）或正式（production，真实下发）通道的日志；用 version 则读指定版本。version 与 mode 都省略 = 读最新版本。',
    {
      scriptId: z.string(),
      version: z.number().int().positive().optional().describe('指定版本号（优先于 mode）'),
      mode: z.enum(['shadow', 'production']).optional().describe('按通道取日志：shadow=当前影子版本，production=当前正式版本'),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    async ({ scriptId, version, mode, limit }) => {
      let v = version;
      let channel = null;
      if (!v && mode) {
        v = store.versionOfChannel(scriptId, mode);
        channel = mode;
        if (!v) return fail(`脚本 ${scriptId} 当前没有 ${mode === 'shadow' ? '影子' : '正式'}版本的日志（该通道不存在版本）`);
      } else if (!v) {
        v = store.listVersions(scriptId).slice(-1)[0];
      }
      if (!v) return fail('脚本不存在：' + scriptId);
      const rec = store.get(scriptId, v);
      if (!rec) return fail(`脚本版本不存在：${scriptId} v${v}`);
      const logs = store.readLogs(scriptId, v, limit || 200);
      return text(JSON.stringify({ scriptId, version: v, channel: channel || store.channelOf(rec.meta), logs }, null, 2));
    }
  );

  server.tool(
    'automation_get_context',
    '只读查询脚本上下文（global / local）。默认返回正式命名空间；shadow=true 返回影子命名空间。',
    { shadow: z.boolean().optional().describe('true=影子命名空间，默认正式') },
    async ({ shadow }) => text(JSON.stringify(context.snapshot(shadow === true), null, 2))
  );

  server.tool(
    'automation_list_versions',
    '只读：列出脚本的所有版本及角色（shadow 影子 / production 正式 / archive 归档）、revision（影子改版次数）、archivedKind（归档分类）、createdAt/updatedAt（updatedAt=影子提交/发布时间）与版本级运行状态 status。影子与正式各至多一个。',
    { scriptId: z.string().describe('脚本 id') },
    async ({ scriptId }) => {
      const versions = store.detailedVersions(scriptId).map((v) => ({
        ...v,
        status: executor.versionRuntimeStatus(scriptId, v.version),
      }));
      if (!versions.length) return fail('脚本不存在或没有版本：' + scriptId);
      return text(JSON.stringify({
        scriptId,
        shadowVersion: store.versionOfChannel(scriptId, 'shadow'),
        productionVersion: store.versionOfChannel(scriptId, 'production'),
        versions,
      }, null, 2));
    }
  );

  server.tool(
    'automation_guard_status',
    '只读：兜底健康检查。返回 HA 连接/就绪态，以及每个运行脚本引用了哪些实体、是否因实体被删而暂停。用于排查脚本为何暂停。',
    {},
    async () => {
      const status = executor.haStatus();
      return text(JSON.stringify({
        ...status,
        haConnection: connector.status,
        haReady: typeof connector.isReady === 'function' ? connector.isReady() : null,
      }, null, 2));
    }
  );

  /* ---------------- HA 自动规划迁移用：只读 ---------------- */
  server.tool(
    'automation_list_ha_automations',
    '列出 HA 里的原生自动化（entity_id / 名称 / 启用态 / mode / 最近触发）。只读快照；配置原文用 automation_get_ha_automation_config。',
    {},
    async () => {
      const list = connector.listAutomations();
      return text(JSON.stringify({ count: list.length, automations: list }, null, 2));
    }
  );

  server.tool(
    'automation_get_ha_automation_config',
    '读取单条 HA 自动化的完整配置（triggers / conditions / actions / mode）。entityId 传 automation.xxx。',
    { entityId: z.string().describe('HA 自动化实体 id，如 automation.zi_dong_kai_qi_re_shui_qi') },
    async ({ entityId }) => {
      const cfg = await connector.getAutomationConfig(entityId);
      return text(JSON.stringify(cfg, null, 2).slice(0, 40000));
    }
  );

  server.tool(
    'automation_list_ha_scripts',
    '列出 HA 原生脚本（script.*）的 entity_id 与启用态。',
    {},
    async () => {
      const list = connector.listHaScripts();
      return text(JSON.stringify({ count: list.length, scripts: list }, null, 2));
    }
  );

  server.tool(
    'automation_get_ha_script_config',
    '读取单条 HA 原生脚本的 sequence 配置。entityId 传 script.xxx。',
    { entityId: z.string().describe('HA 脚本实体 id，如 script.1790462880919') },
    async ({ entityId }) => {
      const cfg = await connector.getScriptConfig(entityId);
      return text(JSON.stringify(cfg, null, 2).slice(0, 40000));
    }
  );

  server.tool(
    'automation_resolve_entities',
    '把 device_id 或十六进制内部 id 解析为真实 HA entity_id（Flode 自动化里常见 device 目标）。传 ids 数组，返回命中的注册表条目。',
    { ids: z.array(z.string()).min(1).describe('device_id 或 entity_id 列表') },
    async ({ ids }) => {
      const list = await connector.resolveEntities(ids);
      return text(JSON.stringify({ count: list.length, entities: list }, null, 2));
    }
  );

  /* ---------------- 受控写（confirmed:true） ---------------- */
  server.tool(
    'automation_submit_script',
    '提交脚本（script.js + flow.json + meta.json）。**影子可反复修改**：当前已有影子版本时，默认原地覆盖该版本（版本号不变、revision+1），不会新增版本号；只有传入 newVersion:true 或当前没有影子时才分配新版本号。正式版/归档版内容不可改（会被拦截），想改正式内容必须提交新影子再发布。需 confirmed:true。**每次提交必须传贴切的中文 name（展示名，可随功能演进更新），严禁用唯一 id 充当名字。**',
    {
      scriptId: z.string().optional().describe('脚本 id（纯字母数字短码）。新建脚本可不传，服务端自动生成；更新已有脚本时传 list_scripts 返回的 id'),
      name: z.string().optional().describe('脚本展示名：**每次提交必须传**一个贴切的中文业务名（如「空调运行关门预警」），可随功能演进更新；**严禁用唯一 id（如 s3acdoor）充当名字**。'),
      script: z.string().describe('JavaScript 源码，只能用 ctx 白名单 API'),
      flow: z.object({
        version: z.number().optional(),
        scriptId: z.string().optional(),
        nodes: z.array(z.object({
          id: z.string(), type: z.enum(['trigger', 'condition', 'action', 'delay', 'announce']),
          label: z.string().optional(), config: z.object({}).passthrough().optional(),
          layout: z.object({ x: z.number(), y: z.number() }).optional(),
        })),
        edges: z.array(z.object({ from: z.string(), to: z.string() })),
      }),
      confirmed: z.literal(true).describe('必须显式确认为 true'),
      kind: z.enum(['automation', 'script', 'scene']).optional().describe('业务种类（同时决定运行模型）：automation=常驻自动化（默认，常驻运行、由 start 管理、无看门狗、不可按次触发）/ script=一次性动作脚本 / scene=场景（后两者跑完即退、有看门狗、可被 trigger/ctx.call）。不传则继承上一版，全新脚本默认 automation'),
      channel: z.enum(['shadow', 'production']).optional().describe('版本角色：默认 shadow（影子，只记日志）；一般不要直接建 production，应先影子验证再 publish'),
      newVersion: z.boolean().optional().describe('强制新开版本号（如回滚、分支试验）。默认 false = 覆盖当前影子'),
      hostMode: z.enum(['fork', 'inprocess', 'worker']).optional().describe('脚本级宿主覆盖（三值对称，跟随版本持久化，影子覆盖迭代自动继承）：fork=独享子进程（隔离最硬，重脚本用）/ inprocess=主进程内 vm（省内存）/ worker=独立线程。不传则继承上一版；未设置过则跟随全局 EXECUTION_MODE。影子实例不受此值影响（影子恒为 fork）'),
      description: z.string().optional().describe('脚本用途说明'),
      icon: z.string().optional().describe('脚本图标：**新脚本首次提交必须提供**（后续迭代可省略，自动继承上一版）。完整 <svg>…</svg> 源码字符串（≤8KB，viewBox 0 0 64 64），线条风格 stroke="currentColor"，颜色随前端主题；按业务画隐喻图形（热水器=水滴+波纹、空调=出风、夜灯=月亮等），绘制规范见 skill references/file-specs.md §icon'),
      runnerTimeoutMs: z.number().optional().describe('脚本级运行超时（毫秒，1000–86400000）。一次性脚本含长延时（如吸氧 30 分钟）时避免全局 runnerTimeoutMs 误杀；不传则继承上一版 / 跟随全局'),
      restartable: z.boolean().optional().describe('可重入触发（对齐 HA script mode:restart）：重复触发时先停旧实例再启新实例，用于「再点一次即取消」的长任务；不传继承上一版'),
    },
    async ({ scriptId, name, script, flow, channel, description, newVersion, hostMode, icon, kind, runnerTimeoutMs, restartable }) => {
      /* dryRun / longRunning 旧参数已从 schema 移除：语义分别由 channel / kind 派生 */
      const err = validateScript(script);
      if (err) return fail('脚本静态校验未通过：' + err);
      const rec = executor.submitScript(scriptId, { name, script, flow, channel, description, newVersion, hostMode, icon, kind, runnerTimeoutMs, restartable });
      /* 让前端重拉列表与该脚本详情：正文/流程图/版本/日志立即刷新为最新。
       * 刷新维度统一走 executor.broadcastRefresh（不再广播无人消费的 what:'flows'）。 */
      executor.broadcastRefresh(['scripts', 'script'], { scriptId: rec.id, version: rec.version });
      return text(JSON.stringify({
        ok: true, id: rec.id, version: rec.version,
        channel: rec.meta.channel, revision: rec.meta.revision,
        overwritten: !!rec.overwritten,
        note: rec.overwritten
          ? `已原地修改影子版本 v${rec.version}（revision=${rec.meta.revision}），版本号未变；运行中的话已停止，需重新 start 才生效。`
          : `已提交为影子版本 v${rec.version}（只记日志不下发设备）；验证通过后 publish 才真实下发。`,
      }, null, 2));
    }
  );

  server.tool(
    'automation_start_script',
    '启动脚本的指定版本。同一脚本最多 1 个正式实例 + 1 个影子实例并行（互不影响）；同槽位已有实例会报错，先 stop。需 confirmed:true。',
    { scriptId: z.string(), version: z.number().int().positive().optional(), confirmed: z.literal(true) },
    async ({ scriptId, version }) => {
      const entry = executor.start(scriptId, version, connector);
      executor.broadcastRefresh(['scripts']);
      return text(JSON.stringify({
        ok: true, scriptId, version: entry.version,
        mode: entry.dryRun ? 'shadow' : 'production',
        runningVersions: executor.runningVersions(scriptId),
      }));
    }
  );

  server.tool(
    'automation_stop_script',
    '停止运行中的脚本。version 省略 = 停全部实例（正式+影子）；给 version 只停该版本实例。需 confirmed:true。',
    { scriptId: z.string(), version: z.number().int().positive().optional(), confirmed: z.literal(true) },
    async ({ scriptId, version }) => {
      const ok = executor.stop(scriptId, 'manual', version);
      ctx.hub.broadcast({ type: 'refresh', what: 'scripts' });
      return ok
        ? text(JSON.stringify({ ok: true, scriptId, stoppedVersion: version ?? 'all', runningVersions: executor.runningVersions(scriptId) }))
        : fail('脚本未在运行：' + scriptId);
    }
  );

  server.tool(
    'automation_trigger_script',
    '按次触发一次性脚本/场景（kind=script/scene）：起独立实例跑一遍顶层代码，跑完自动清理。channel 省略 = 正式通道（真实下发）；channel=shadow 触发影子版本（设备写只记日志不下发，用于影子验证）。只返回启动回执——不等脚本跑完、无返回值；要看结果用 automation_get_logs / get_script_status。常驻自动化（kind=automation）不能按次触发，请用 start 管理。需 confirmed:true。',
    {
      scriptId: z.string().describe('脚本 id'),
      channel: z.enum(['production', 'shadow']).optional()
        .describe('触发通道：production=正式（默认，真实下发）；shadow=影子（只记日志不下发，验证用）'),
      confirmed: z.literal(true).describe('必须显式确认为 true'),
    },
    async ({ scriptId, channel }) => {
      const ch = channel || 'production';
      const r = executor.trigger(scriptId, connector, ch);
      executor.broadcastRefresh(['scripts']);
      return text(JSON.stringify({
        ok: true, ...r,
        note: `已按次触发 ${scriptId} v${r.version}（${ch === 'shadow' ? '影子，写不下发' : '正式，真实下发'}）；`
          + '只等启动回执，不等跑完——稍后用日志/状态接口确认执行结果。',
      }, null, 2));
    }
  );

  /* ---------------- 版本角色写操作：影子 / 正式 / 归档 ---------------- */
  server.tool(
    'automation_publish_script',
    '发布影子版本为正式版本：旧正式版本自动归档，新正式版本真实下发 HA 控制。若正在运行的是**另一个版本**，默认自动切换实例（停旧→以影子启动新→发布并热切为真实下发；新版本起不来会自动回退旧版本）；autoSwitch:false 则改为严格报错要求先 stop。请在影子逻辑验证无误后调用。需 confirmed:true。',
    {
      scriptId: z.string().describe('脚本 id'),
      version: z.number().int().positive().optional().describe('要发布的影子版本号；省略则取当前影子版本'),
      autoSwitch: z.boolean().optional().describe('运行中版本与目标不一致时是否自动切换实例，默认 true'),
      confirmed: z.literal(true).describe('必须显式确认为 true'),
    },
    async ({ scriptId, version, autoSwitch }) => {
      const r = executor.publish(scriptId, version, { autoSwitch: autoSwitch !== false });
      return text(JSON.stringify({
        ok: true, ...r,
        note: `v${r.version} 已发布为正式版本（真实下发）；旧正式${r.previousProduction ? ' v' + r.previousProduction + ' 已归档' : '不存在'}。`
          + (r.switchedFrom ? `运行实例已从 v${r.switchedFrom} 切换到 v${r.version}。` : ''),
      }, null, 2));
    }
  );

  server.tool(
    'automation_rollback',
    '回滚到历史版本：读取该版本的 script.js/flow.json 原文，作为一个**新版本（影子）**提交（版本号继续递增，内容与老版本一致）。不自动发布——回滚同样要先影子验证再显式 publish。正式版与归档版内容不可变，因此读到的就是当初上线的原文。需 confirmed:true。',
    {
      scriptId: z.string().describe('脚本 id'),
      fromVersion: z.number().int().positive().describe('要回滚到的历史版本号（正式或归档版本）'),
      confirmed: z.literal(true).describe('必须显式确认为 true'),
    },
    async ({ scriptId, fromVersion }) => {
      /* 走 executor.rollback：被回滚归档的影子若在跑会先停（与提交语义对齐，不占影子槽位） */
      const rec = executor.rollback(scriptId, fromVersion);
      executor.broadcastRefresh(['scripts', 'script'], { scriptId: rec.id, version: rec.version });
      return text(JSON.stringify({
        ok: true, id: rec.id, version: rec.version, fromVersion: rec.fromVersion,
        fromChannel: rec.fromChannel, description: rec.meta.description,
        note: `已把 v${rec.fromVersion} 的内容提交为影子版本 v${rec.version}（只记日志不下发设备）；验证后 publish 才会上线。`,
      }, null, 2));
    }
  );

  server.tool(
    'automation_delete_version',
    '清理**归档版本**（删除目录与日志）。正式版本不可删（先发布新版本使其归档）、影子版本是工作副本不可删（直接覆盖修改即可）、正在运行的版本不可删（先 stop）。需 confirmed:true。',
    {
      scriptId: z.string().describe('脚本 id'),
      version: z.number().int().positive().describe('要删除的版本号'),
      confirmed: z.literal(true).describe('必须显式确认为 true'),
    },
    async ({ scriptId, version }) => {
      const r = executor.removeVersion(scriptId, version);
      return text(JSON.stringify({ ok: true, ...r }, null, 2));
    }
  );

  server.tool(
    'automation_select_script',
    '切换前端面板选中项：左侧脚本列表选中该脚本并打开详情（可指定版本）。用于提交/启停/发布后把用户视线带到目标脚本，便于人工验证影子效果。',
    {
      scriptId: z.string().describe('脚本 id'),
      version: z.number().int().positive().optional().describe('要打开的版本号；省略则打开最新版本'),
    },
    async ({ scriptId, version }) => {
      if (!store.get(scriptId, version)) return fail('脚本版本不存在：' + scriptId + (version ? ' v' + version : ''));
      ctx.hub.broadcast({ type: 'select', scriptId, version });
      return text(JSON.stringify({ ok: true, scriptId, version: version || 'latest' }));
    }
  );

  server.tool(
    'automation_refresh_panel',
    '让前端面板重新拉取最新数据并刷新展示。what=all 时刷新脚本列表 + 当前打开脚本的详情/版本条/日志；也可只刷新单一维度。用于提交/启停/发布后确保用户看到最新状态。',
    {
      what: z.enum(['scripts', 'script', 'versions', 'logs', 'all']).optional()
        .describe('刷新范围：scripts=左侧脚本列表；script=当前打开脚本的正文/流程图；versions=版本条；logs=日志；all=以上全部（默认）'),
    },
    async ({ what }) => {
      const scope = what || 'all';
      const items = scope === 'all' ? ['scripts', 'script', 'versions', 'logs'] : [scope];
      executor.broadcastRefresh(items); // 刷新维度统一出口（审计 F9）
      return text(JSON.stringify({ ok: true, refreshed: items }));
    }
  );

  server.tool(
    'automation_call_service',
    '直接调用 HA 服务（默认关闭：需服务端开启 allowMcpCallService 且 confirmed:true）。',
    { domain: z.string(), service: z.string(), data: z.object({}).passthrough().optional(), confirmed: z.literal(true) },
    async ({ domain, service, data }) => {
      if (!ctx.allowMcpCallService) return fail('该工具默认关闭（allowMcpCallService=false）');
      /* 开发模式不拦 MCP 直调：写闸只约束脚本发起的 HA 写，MCP 是用户显式操作，
       * 需自己确认（confirmed:true），与 NAS 双份裁决的风险由调用方承担。 */
      const d = { ...(data || {}) };
      const eid = d.entity_id;
      const chk = executor.acquireAction(domain, service, eid);
      if (!chk.ok) return fail(chk.reason);
      try {
        const r = await connector.callService(domain, service, d);
        return text(JSON.stringify({ ok: true, result: r }, null, 2));
      } finally {
        executor.releaseAction(chk.key); // L5：释放互斥锁，避免首次调用后永久锁死
      }
    }
  );

  /* ---------------- 影子双模式验证：仿真控制（SIMULATION-DESIGN §8）----------------
   * 不新增"仿真通道"：影子通道固定，验证方式 follow/simulate 二选一，切换走暂停→启动。
   * 仿真只覆盖本脚本流程与逻辑，不联动其他脚本；WS 广播只发状态，不注入当真实事件。 */
  server.tool(
    'automation_switch_verify_mode',
    '切换影子的验证方式：follow（跟随真实 HA/时钟，即现在的影子）或 simulate（虚拟实体/虚拟时钟/写意图）。内部走「暂停旧实例→等真正退出→以目标模式启动」，不做热切换，正式实例不受影响。startAt 为 ISO（如 2026-11-26T20:29:55+08:00），seed 为 { entities, context }。需 confirmed:true。',
    {
      scriptId: z.string().describe('脚本 id'),
      mode: z.enum(['follow', 'simulate']).describe('目标验证方式'),
      startAt: z.string().optional().describe('simulate 起始时刻 ISO（缺省当前系统时间）'),
      seed: z.object({}).passthrough().optional().describe('simulate 种子：{ entities: { eid: { state, attributes } }, context: { global, local } }'),
      confirmed: z.literal(true).describe('必须显式确认为 true'),
    },
    async ({ scriptId, mode, startAt, seed }) => {
      const r = await executor.switchVerifyMode(scriptId, mode, { startAt, seed });
      executor.broadcastRefresh(['scripts', 'script']);
      return text(JSON.stringify({
        ok: true, ...r,
        note: r.idempotent
          ? `脚本 ${scriptId} 已经是 ${mode} 模式，无需切换。`
          : `已从 ${r.from} 切换到 ${mode}（影子 v${r.version}）。` + (mode === 'simulate'
            ? ' 虚拟世界已就绪，用 sim_inject 注入实体状态、sim_advance 快进时间、sim_snapshot 取证据。'
            : ' 已恢复真实 HA 数据与时钟。'),
      }, null, 2));
    }
  );

  server.tool(
    'automation_sim_inject',
    '向仿真实例注入一个变化：实体状态（entity，先改虚拟表再触发订阅回调）、上下文（context）、依赖脚本状态（task）、挂起（suspend）。一次一个，AI 看响应后再决定下一步。需 confirmed:true。',
    {
      scriptId: z.string(),
      payload: z.object({
        entity: z.object({ entityId: z.string(), state: z.any().optional(), attributes: z.object({}).passthrough().optional(), friendly_name: z.string().optional() }).optional(),
        context: z.object({ scope: z.enum(['global', 'local']).optional(), key: z.string(), value: z.any() }).optional(),
        task: z.object({ scriptId: z.string(), state: z.enum(['running', 'stopped', 'error', 'paused']) }).optional(),
        suspend: z.boolean().optional(),
      }).describe('注入内容，可组合多个字段'),
      confirmed: z.literal(true),
    },
    async ({ scriptId, payload }) => {
      const r = await executor.simInject(scriptId, payload);
      return text(JSON.stringify({ ok: true, ...r }, null, 2));
    }
  );

  server.tool(
    'automation_sim_advance',
    '快进仿真实例的虚拟时钟（毫秒）。到点定时器按 dueAt 顺序触发，脚本回调内的 request 在微任务内应答。返回本次推进量与新时刻。需 confirmed:true。',
    {
      scriptId: z.string(),
      ms: z.number().int().min(0).describe('快进毫秒数'),
      confirmed: z.literal(true),
    },
    async ({ scriptId, ms }) => {
      const r = await executor.simAdvance(scriptId, ms);
      return text(JSON.stringify({ ok: true, ...r }, null, 2));
    }
  );

  server.tool(
    'automation_sim_run_steps',
    '批量跑完整用例：一次提交整组 steps 顺序执行并逐步断言，返回每条断言的通过/失败（含实际写意图序列）与终态快照，适合回归。step.op 支持 advance / inject_entity / inject_context / inject_task / inject_params / inject_suspend / mark / rewind / snapshot / assert。断言字段：writes（写意图序列，按 kind/op/nodeId/args 部分匹配，自上次 assert 以来新增）、noWrites（true 或 op 列表）、state（实体终值）、context、logs、expect（路径 DSL，见 automation_sim_snapshot 说明）。**默认每次重建虚拟世界**（用例可独立重跑），传 startAt/seed 指定起点；只有 continue:true 才在当前仿真会话续跑（多段探索，此时不能再传 startAt/seed）。断言失败默认不中断（收集全部失败点），failFast:true 首败即停。需 confirmed:true。',
    {
      scriptId: z.string().describe('脚本 id'),
      steps: z.array(z.object({ op: z.enum(['advance', 'inject_entity', 'inject_context', 'inject_task', 'inject_params', 'inject_suspend', 'mark', 'rewind', 'snapshot', 'assert']) }).passthrough())
        .min(1).describe('步骤数组，见各 op 字段：advance.ms / inject_*.entityId|state|scope|key|value|scriptId|params|suspend / mark.name / rewind.mark / assert.writes|noWrites|state|context|logs|expect'),
      startAt: z.string().optional().describe('给定则用该 ISO 起点重建世界（如 2026-11-26T20:29:55+08:00）'),
      seed: z.object({}).passthrough().optional().describe('随重建一起生效的种子：{ entities, context }'),
      continue: z.boolean().optional().describe('true = 在当前仿真会话上续跑（保留世界状态）；缺省 false = 每次重建'),
      failFast: z.boolean().optional().describe('首个断言失败即停，缺省收集全部失败点'),
      confirmed: z.literal(true),
    },
    async ({ scriptId, steps, startAt, seed, continue: reuse, failFast }) => {
      const r = await executor.simRunSteps(scriptId, { steps, startAt, seed, continue: reuse, failFast });
      return text(JSON.stringify({
        ok: r.ok, passed: r.passed, failed: r.failed, total: r.total,
        executed: r.executed, aborted: r.aborted,
        steps: r.results, final: r.final,
      }, null, 2));
    }
  );

  server.tool(
    'automation_sim_snapshot',
    '同步拉取仿真会话快照：clockNow/seq、logs、writes（写意图=硬证据）、entities、context、stats、execution/timers/watchers（脚本此刻在等什么）。entities 默认只含脚本用过的实体（读过/写过/注入过），要全量传 entityScope:"all"。since 传上次 seq 只取增量；include 裁剪字段。两次 advance 之间世界静止，拉取不漏事件。需 confirmed:true。',
    {
      scriptId: z.string(),
      since: z.number().int().min(0).optional().describe('上次快照的 seq，只返回新增 logs/writes'),
      include: z.array(z.enum(['logs', 'writes', 'entities', 'context', 'stats', 'execution', 'timers', 'watchers'])).optional().describe('字段裁剪，缺省全部'),
      entityScope: z.enum(['used', 'all']).optional().describe('used（缺省）= 只回脚本用过的实体；all = 全量虚拟实体表'),
      confirmed: z.literal(true),
    },
    async ({ scriptId, since, include, entityScope }) => {
      const r = await executor.simSnapshot(scriptId, { since, include, entityScope });
      return text(JSON.stringify(r, null, 2));
    }
  );

  server.tool(
    'automation_sim_close',
    '结束仿真实例（等价停止 simulate 影子实例，虚拟世界随之销毁、不持久化）。已停止或没有实例也视为成功；当前影子是 follow 模式时会拒绝（避免误停真实验证态），停 follow 请用 automation_stop_script。需 confirmed:true。',
    {
      scriptId: z.string(),
      confirmed: z.literal(true),
    },
    async ({ scriptId }) => {
      const r = await executor.simClose(scriptId);
      return text(JSON.stringify({
        ok: true, ...r,
        running: executor.isRunning(scriptId),
        runningVersions: executor.runningVersions(scriptId),
      }, null, 2));
    }
  );

  /* ---------- P2：交互式断言 / 时间旅行 / 用例导出 ---------- */

  server.tool(
    'automation_sim_assert',
    '对当前仿真会话做一次断言（不重建世界、不推进时间）。字段与 run_steps 的 assert 相同：writes / noWrites / state / context / logs / expect。增量基准默认「自上次断言以来新增」，可用 since 指定 seq。expect 是路径 DSL：{path:"writes[0].op", eq:"heatOn"}，算子 eq/ne/gt/gte/lt/lte/match/includes/exists/type，可组合 all/any/not，数组即全部满足。返回每条 check 的通过情况与路径实际值。需 confirmed:true。',
    {
      scriptId: z.string(),
      expect: z.union([z.object({}).passthrough(), z.array(z.object({}).passthrough())]).optional()
        .describe('路径 DSL，例：[{path:"writes.length", eq:2},{path:"context.global.heated", eq:true}]'),
      writes: z.array(z.object({}).passthrough()).optional().describe('写意图序列精确匹配（自上次断言以来）'),
      noWrites: z.union([z.literal(true), z.array(z.string())]).optional().describe('true=不允许任何写意图；数组=不允许这些 op'),
      state: z.array(z.object({}).passthrough()).optional().describe('实体终值：[{entityId, state?, attributes?}]'),
      context: z.array(z.object({}).passthrough()).optional().describe('上下文值：[{scope?, key, value}]'),
      logs: z.array(z.union([z.string(), z.object({}).passthrough()])).optional().describe('日志出现：字符串包含或 {level?, message?}'),
      label: z.string().optional().describe('断言名，便于结果里区分'),
      since: z.number().int().min(0).optional().describe('从该 seq 之后取增量（缺省用上次断言游标）'),
      confirmed: z.literal(true),
    },
    async ({ scriptId, since, confirmed, ...step }) => {
      const r = await executor.simAssert(scriptId, step, { since });
      return text(JSON.stringify(r, null, 2));
    }
  );

  server.tool(
    'automation_sim_mark',
    '给当前仿真世界打标记（实体/上下文/task 的数据点），用于之后 sim_rewind 回到这个输入状态测试另一条分支。name 缺省自动生成。需 confirmed:true。',
    {
      scriptId: z.string(),
      name: z.string().optional().describe('标记名，缺省 m1/m2…'),
      confirmed: z.literal(true),
    },
    async ({ scriptId, name }) => text(JSON.stringify(await executor.simMark(scriptId, name), null, 2))
  );

  server.tool(
    'automation_sim_rewind',
    '把仿真世界的数据回滚到某个标记点（实体/上下文/task），用于在不同输入下重试同一段逻辑。**只回滚数据**：虚拟时钟继续前进、脚本已注册的定时器与订阅不回退；要完全重放请用 run_steps 重建或 sim_run_fixture。需 confirmed:true。',
    {
      scriptId: z.string(),
      mark: z.string().describe('sim_mark 返回的标记名'),
      confirmed: z.literal(true),
    },
    async ({ scriptId, mark }) => text(JSON.stringify(await executor.simRewind(scriptId, mark), null, 2))
  );

  server.tool(
    'automation_sim_export',
    '把当前仿真会话导成回归用例并落盘（skill/.fixtures/<脚本id>/<name>.json，与可复用用例同目录、随 skill.zip 走）：起始时刻 + 初始种子 + 驱动流水（所有 inject/advance）+ 观测到的写意图序列 + 脚本版号。导出后可用 sim_run_fixture 一键重放。需 confirmed:true。',
    {
      scriptId: z.string(),
      name: z.string().describe('用例名（字母数字与 _ . -，最长 64）'),
      force: z.boolean().optional().describe('同名用例带断言（手写）时也强行覆盖；默认拒绝'),
      confirmed: z.literal(true),
    },
    async ({ scriptId, name, force }) => text(JSON.stringify(await executor.simExport(scriptId, name, { force }), null, 2))
  );

  server.tool(
    'automation_sim_run_fixture',
    '重放已导出的用例：重建世界 → 跑 fixture 的 steps → 用导出时的写意图序列做全序列断言；versionDrift=true 说明脚本已改版，断言失败先怀疑版本漂移。不传 name 只列已有用例。需 confirmed:true。',
    {
      scriptId: z.string(),
      name: z.string().optional().describe('用例名；缺省则只列出该脚本已有的用例'),
      assertWrites: z.boolean().optional().describe('是否追加写意图全序列断言，缺省 true'),
      failFast: z.boolean().optional().describe('首个断言失败即停'),
      confirmed: z.literal(true),
    },
    async ({ scriptId, name, assertWrites, failFast }) => {
      if (!name) return text(JSON.stringify(await executor.simListFixtures(scriptId), null, 2));
      const r = await executor.simRunFixture(scriptId, name, { assertWrites, failFast });
      return text(JSON.stringify({
        ok: r.ok, passed: r.passed, failed: r.failed, total: r.total,
        executed: r.executed, aborted: r.aborted, fixture: r.fixture,
        steps: r.results, final: { at: r.final.at, clockNow: r.final.clockNow, writes: r.final.writes },
      }, null, 2));
    }
  );
}

module.exports = { buildTools };
