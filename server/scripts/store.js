'use strict';
/* 脚本仓库：每个脚本按版本目录存三文件（script.js / flow.json / meta.json）。
 * 运行状态不落 meta（executor 内存判定），运行身份由 channel 派生。
 *
 * 版本角色（channel）：
 *   shadow    影子版本（只记日志）—— 至多 1 个，**可原地反复修改**
 *   production 正式版本（真实下发）—— 至多 1 个，**内容不可变**
 *   archive   归档版本（历史，不参与发布）—— 不可变；分两类：
 *               archivedKind=published（曾经上线，回滚候选）/ discarded（影子试错废弃）
 * 迭代语义（单向）：
 *   提交/修改 → 覆盖当前 shadow（版本号不变，revision+1）
 *            → publish（shadow 转 production，同版本号；旧 production 转 archive）
 *            → 想再改只能新建下一版本号（因为正式版不可改，shadow 已空）
 * 回滚 = 读旧版内容 → 提交为新版本（shadow，版本号继续增）→ 再 publish。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA, ensureDataDir } = require('../config');
const context = require('./context');
const { safeId: validateSid } = require('./inst-key'); // id 校验唯一实现在 inst-key（防三处正则漂移）

const SCRIPTS_DIR = path.join(DATA, 'scripts');
const CHANNELS = ['shadow', 'production', 'archive'];
/* 宿主模式合法值（executor 选宿主用；meta.hostMode 脚本级覆盖也用这个白名单校验）：
 *   fork      每实例独立子进程（隔离最硬）；inprocess 主进程内 vm；worker 每实例一个线程。 */
const EXECUTION_HOST_MODES = ['fork', 'inprocess', 'worker'];
/* 脚本业务种类：automation=常驻自动化、script=一次性动作、scene=场景（一次性动作）。
 * 运行模型（常驻 vs 一次性）完全由 kind 派生：kind==='automation' 即常驻（无看门狗、
 * 由 start 管理、可 ctx.call 不可按次触发）；script/scene 为一次性（有看门狗、可 trigger/call）。
 * 历史字段 longRunning 已退役（2026-11-26）：kind 缺省时由 kindOf 按 automation 补写。
 * 缺省按 automation 处理，兼容全部历史脚本；不传时继承上一版。 */
const SCRIPT_KINDS = ['automation', 'script', 'scene'];

/* 脚本 icon（可选）：SVG 源码字符串，存 meta.json，前端脚本列表/详情直接渲染。
 * 安全校验：限长 + 只认完整 <svg>…</svg>，拒绝脚本注入与外链引用；
 * 风格约定：stroke/fill 用 currentColor，颜色随前端主题（accent/运行态）走。 */
const ICON_MAX_LEN = 8192;
function validIcon(icon) {
  if (icon == null) return null;
  const s = String(icon).trim();
  if (!s) return null;
  if (s.length > ICON_MAX_LEN) throw new Error(`icon 过大（${s.length} > ${ICON_MAX_LEN} 字符）`);
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) throw new Error('icon 必须是完整的 <svg>…</svg> 字符串');
  if (/<script|<iframe|<foreignObject|<use\b|<image\b|on\w+\s*=|javascript:|data:text\/html/i.test(s)) {
    throw new Error('icon 含不允许的内容（script / 事件属性 / 外链引用）');
  }
  return s;
}
/* 状态机已退役（2026-11-26）：meta.json 不再存 status，运行状态由 executor 内存判定。 */

function safeId(id) { return validateSid(id); }

/* 脚本 id：纯小写字母 + 数字的 8 位唯一短码（类 nanoid），便于在界面上点击复制、
 * 也避免语义名重复/改名带来的引用漂移。已存在的目录名不会被再次生成。 */
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function newScriptId(len = 8) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const bytes = crypto.randomBytes(len);
    let s = '';
    for (let i = 0; i < len; i++) s += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
    if (!fs.existsSync(scriptDir(s))) return s;
  }
  return 's' + Date.now().toString(36).slice(-7) + Math.floor(Math.random() * 36).toString(36);
}
function scriptDir(id) { return path.join(SCRIPTS_DIR, id); }
function versionDir(id, version) { return path.join(scriptDir(id), 'v' + Number(version)); }
function sha256(text) { return crypto.createHash('sha256').update(String(text)).digest('hex'); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

/* 已退役字段（2026-11-26）：status（运行状态 → executor 内存）、publishedAt（发布时间 → updatedAt）、
 * longRunning（运行模型 → 由 kind 派生）、dryRun（运行身份 → 由 channel 派生）。
 * 不设独立剥离函数：normalizeChannels 循环内逐字段剥离（残留即触发迁移写盘），
 * submit / publish 入口都先跑 normalizeChannels，落盘 meta 天然不含退役字段。 */

/* kind 缺省派生：非法/缺失一律按 automation（历史常驻脚本占多数，缺省口径一致）。
 * 旧字段 longRunning 已退役（2026-11-26），不再参与推断——真实数据已全部迁移为显式 kind。 */
function kindOf(meta) {
  return meta && SCRIPT_KINDS.includes(meta.kind) ? meta.kind : 'automation';
}
function writeJson(file, obj) {
  ensureDataDir();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  /* 原子写（tmp+rename）：崩溃撞上直接 writeFileSync 会留半截 JSON，
   * readJson 拿到 null 后该版本在 get()/restore() 里"消失"。与 run-state/context 对齐。 */
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function listIds() {
  ensureDataDir();
  try { return fs.readdirSync(SCRIPTS_DIR).filter((d) => safeId(d) && fs.statSync(path.join(SCRIPTS_DIR, d)).isDirectory()); }
  catch (e) { return []; }
}

/* 在已读出的 meta 集合里找某渠道的最新版本号（避免重复读盘） */
function pickChannelVersion(metas, channel) {
  const hit = metas.filter((x) => channelOf(x.meta) === channel).map((x) => x.v);
  return hit.length ? Math.max(...hit) : null;
}

/* 列出脚本的最新版本摘要（含影子/正式版本指针） */
function list() {
  return listIds().map((id) => {
    normalizeChannels(id);
    /* 单次请求内只读一遍全部 meta：versionOfChannel 各自 normalize+allMetas 会对
     * 每个脚本做 O(版本×3) 次文件读（审计 F5），这里复用同一份。 */
    const metas = allMetas(id);
    const versions = metas.map((x) => x.v).sort((a, b) => a - b);
    const latest = versions.length ? versions[versions.length - 1] : null;
    const metaOf = (v) => (v == null ? {} : (metas.find((x) => x.v === v) || {}).meta || {});
    const meta = metaOf(latest);
    const shadowV = pickChannelVersion(metas, 'shadow');
    const prodV = pickChannelVersion(metas, 'production');
    /* 展示口径（name/description/kind）正式版优先：正式版本的元信息更具权威性 */
    const displayMeta = (prodV ? metaOf(prodV) : meta);
    const shadowMeta = metaOf(shadowV);
    return {
      id, latestVersion: latest, name: displayMeta.name || id,
      /* updatedAt 语义（2026-11-26 收窄）：影子代码提交时间，或影子转正式（发布）时间。
       * 运行状态（running/paused/error）不再存 meta，由 executor 内存 + desired-running.json 维护。 */
      updatedAt: meta.updatedAt || null,
      shadowVersion: shadowV, productionVersion: prodV,
      /* 影子可反复原地修改：revision 是"改了几次"，version 是"第几个候选版" */
      shadowRevision: shadowV ? (Number(shadowMeta.revision) || 1) : 0,
      /* 运行模型由 kind 派生：automation=常驻，script/scene=一次性 */
      kind: kindOf(displayMeta),
      description: displayMeta.description || null,
      icon: displayMeta.icon || null,
    };
  });
}

function listVersions(id) {
  if (!safeId(id)) return [];
  const dir = scriptDir(id);
  try {
    return fs.readdirSync(dir)
      .map((d) => /^v(\d+)$/.exec(d))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  } catch (e) { return []; }
}

/* 版本渠道：一律读 meta.channel（dryRun 已退役，不留读取兜底）；
 * 无合法 channel 的异常 meta 归 shadow，交给 normalizeChannels 收敛。 */
function channelOf(meta) {
  return CHANNELS.includes(meta && meta.channel) ? meta.channel : 'shadow';
}

/* 读取所有版本的 meta */
function allMetas(id) {
  return listVersions(id).map((v) => ({ v, meta: readJson(path.join(versionDir(id, v), 'meta.json'), null) }))
    .filter((x) => x.meta);
}

/* 渠道不变式校验/自愈：至多 1 个 shadow、1 个 production。
 * 异常数据可能同时有多个 shadow，这里保留最新的一个为 shadow，其余归档。
 * 返回是否发生迁移写盘。 */
function normalizeChannels(id) {
  if (!safeId(id)) return false;
  const items = allMetas(id);
  if (!items.length) return false;
  const shadowVs = items.filter((x) => channelOf(x.meta) === 'shadow').map((x) => x.v);
  const prodVs = items.filter((x) => channelOf(x.meta) === 'production').map((x) => x.v);
  const keepShadow = shadowVs.length ? Math.max(...shadowVs) : null;
  const keepProd = prodVs.length ? Math.max(...prodVs) : null;
  let migrated = false;
  for (const { v, meta } of items) {
    let ch = channelOf(meta);
    if (ch === 'shadow' && v !== keepShadow) ch = 'archive';
    if (ch === 'production' && v !== keepProd) ch = 'archive';
    let changed = false;
    if (meta.channel !== ch) { meta.channel = ch; changed = true; }
    /* kind 缺省补写：读侧 kindOf 有缺省派生，normalize 触碰该 meta 时顺手落盘固化 */
    if (!SCRIPT_KINDS.includes(meta.kind)) { meta.kind = kindOf(meta); changed = true; }
    /* 退役字段（dryRun/longRunning/status/publishedAt）不再剥离：读侧一律优先读
     * channel/kind 等现行字段，残留无害；真实数据已全部为终态 meta。 */
    if (changed) {
      /* 渠道迁移不改 updatedAt（语义=代码提交/发布时间，迁移不是内容变化） */
      writeJson(path.join(versionDir(id, v), 'meta.json'), meta);
      migrated = true;
    }
  }
  return migrated;
}

/* 找当前 shadow / production 版本；没有则 null */
function versionOfChannel(id, channel) {
  if (!safeId(id)) return null;
  normalizeChannels(id);
  const hit = allMetas(id).filter((x) => x.meta.channel === channel).map((x) => x.v);
  return hit.length ? Math.max(...hit) : null;
}

function detailedVersions(id) {
  if (!safeId(id)) return [];
  normalizeChannels(id);
  return allMetas(id).map(({ v, meta }) => {
    const ch = channelOf(meta);
    return {
      version: v, channel: ch,
      name: meta.name || id,
      /* revision：影子被原地修改过几次（1 = 只提交过一次）；production/archive 恒为 1 */
      revision: Number(meta.revision) || 1,
      /* mutable：只有影子可覆盖修改；正式/归档内容不可变 */
      mutable: ch === 'shadow',
      /* 归档分类：published = 曾经上线过（回滚候选），discarded = 影子试错废弃。
       * archivedKind 在归档动作发生时写入；缺失按 discarded 处理。 */
      archivedKind: ch === 'archive' ? (meta.archivedKind || 'discarded') : null,
      sha256: meta.sha256 || null,
      createdAt: meta.createdAt || null, updatedAt: meta.updatedAt || null,
      description: meta.description || null,
    };
  }).sort((a, b) => b.version - a.version);
}

function get(id, version) {
  if (!safeId(id)) return null;
  const vs = listVersions(id);
  const v = version == null ? (vs.length ? vs[vs.length - 1] : null) : Number(version);
  if (v == null || !vs.includes(v)) return null;
  const dir = versionDir(id, v);
  const meta = readJson(path.join(dir, 'meta.json'), null);
  if (!meta) return null;
  const script = (() => { try { return fs.readFileSync(path.join(dir, 'script.js'), 'utf8'); } catch (e) { return ''; } })();
  const flow = readJson(path.join(dir, 'flow.json'), null);
  return { id, version: v, meta, script, flow };
}

function validateFlow(flow) {
  if (!flow || typeof flow !== 'object') return 'flow.json 缺失或不是对象';
  if (!Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) return 'flow.json 需要 nodes / edges 数组';
  const allowed = new Set(['trigger', 'condition', 'action', 'delay', 'announce']);
  const ids = new Set();
  for (const n of flow.nodes) {
    if (!n || typeof n !== 'object') return '节点不是对象';
    if (!n.id || typeof n.id !== 'string') return '节点缺少 id';
    if (ids.has(n.id)) return '节点 id 重复：' + n.id;
    ids.add(n.id);
    if (!allowed.has(n.type)) return '未知节点类型：' + n.type;
  }
  for (const e of flow.edges) {
    if (!e || !ids.has(e.from) || !ids.has(e.to)) return '连线指向不存在的节点';
  }
  return null;
}

/* 提交脚本。两种行为：
 * ① **修改当前影子**（默认）：已存在 shadow 且未指定 newVersion、未显式指定非影子通道
 *    → 原地覆盖该版本：版本号不变、meta.revision+1、sha256/flow/meta 更新。
 *    影子的反复修改不再消耗版本号（"影子下可以一直改"）。
 * ② **分配新版本号**：newVersion=true，或显式 channel=production/archive，
 *    或当前没有影子 → version = max(existing)+1。
 * 通道不变式：影子至多 1 个（覆盖不再产生第二个）；推送新影子时旧影子归档。
 * 版本内容不可变只针对 production / archive —— 由 publish 之后 shadow 已空 + 
 * 覆盖仅命中 shadow 来保证。 */
function submit(id, { name, script, flow, description, channel, newVersion, hostMode, icon, kind, runnerTimeoutMs, restartable }) {
  /* dryRun / longRunning 旧参数不再接收：语义分别由 channel / kind 派生，
   * 兼容层"接收即丢弃"只会给调用方"已生效"的错觉（审计 D5）。 */
  const sid = id ? safeId(id) : newScriptId();
  if (!sid) throw new Error('脚本 id 非法（仅允许字母数字 _ -，1–64 位）');
  if (typeof script !== 'string' || !script.trim()) throw new Error('脚本内容不能为空');
  const flowError = validateFlow(flow);
  if (flowError) throw new Error(flowError);
  /* 脚本级宿主覆盖（三值对称）：提交即校验，fail-fast；不传则从被覆盖的上一版继承
   * （与 kind 同策略），保证影子反复迭代不丢配置。 */
  if (hostMode != null && !EXECUTION_HOST_MODES.includes(hostMode)) {
    throw new Error(`hostMode 非法：${hostMode}（仅允许 ${EXECUTION_HOST_MODES.join(' / ')}）`);
  }
  if (kind != null && !SCRIPT_KINDS.includes(kind)) {
    throw new Error(`kind 非法：${kind}（仅允许 ${SCRIPT_KINDS.join(' / ')}）`);
  }
  /* 脚本级运行超时：一次性脚本含长延时（如吸氧 30 分钟）时避免全局 60s 看门狗误杀。
   * 下限 1s、上限 24h，防止误传 0 / 负数 / 超大值导致实例永不回收。 */
  if (runnerTimeoutMs != null) {
    const t = Number(runnerTimeoutMs);
    if (!Number.isFinite(t) || t < 1000 || t > 24 * 3600 * 1000) {
      throw new Error(`runnerTimeoutMs 非法：${runnerTimeoutMs}（允许 1000–86400000 毫秒）`);
    }
  }
  /* icon 同样 fail-fast：传了但不合法直接拒绝提交；不传则从继承源继承（见下方 meta 组装） */
  const iconSvg = validIcon(icon);
  normalizeChannels(sid);
  const explicitCh = CHANNELS.includes(channel) ? channel : null;
  const currentShadow = versionOfChannel(sid, 'shadow');
  /* 只有"显式要 production/archive"或 newVersion 才强制开新号；
   * 显式 channel:'shadow' 与不传等价（都是影子），仍走原地覆盖。 */
  const forceNew = !!newVersion || (explicitCh != null && explicitCh !== 'shadow');
  const overwrite = !forceNew && currentShadow != null;

  const vs = listVersions(sid);
  const version = overwrite ? currentShadow : (vs.length ? vs[vs.length - 1] + 1 : 1);
  const ch = overwrite ? 'shadow' : (explicitCh || 'shadow');
  const prevMeta = overwrite ? (readJson(path.join(versionDir(sid, version), 'meta.json'), null) || {}) : null;
  /* hostMode 继承源：覆盖影子时是该影子自身；新开版本号时是最近一版（任意 channel）——
   * 保证“影子 → 发布 → 再开新影子”的迭代链不丢宿主配置。 */
  const inheritMeta = prevMeta
    || (vs.length ? (readJson(path.join(versionDir(sid, vs[vs.length - 1]), 'meta.json'), null)) : null);

  // 推送新影子时把旧影子归档（至多一个影子）；覆盖模式不存在这个问题
  if (!overwrite && ch === 'shadow') {
    const oldShadow = versionOfChannel(sid, 'shadow');
    if (oldShadow != null) {
      const om = readJson(path.join(versionDir(sid, oldShadow), 'meta.json'), null);
      if (om) {
        om.channel = 'archive';
        om.archivedKind = 'discarded';
        writeJson(path.join(versionDir(sid, oldShadow), 'meta.json'), om);
      }
    }
  }

  const dir = versionDir(sid, version);
  ensureDataDir();
  fs.mkdirSync(dir, { recursive: true });
  // 强制 flow.scriptId 与实际目录 id 绑定，避免图与代码漂移（B8）
  const boundFlow = { ...flow, scriptId: sid };
  fs.writeFileSync(path.join(dir, 'script.js'), script);
  writeJson(path.join(dir, 'flow.json'), boundFlow);
  const now = new Date().toISOString();
  /* updatedAt 语义（2026-11-26 收窄）：本版本的"内容定稿时间"——影子提交时=提交时间。
   * 不再携带 status（运行状态由 executor 内存 + desired-running.json 维护），
   * 也不随状态迁移/渠道迁移/归档而改写。 */
  const meta = {
    id: sid, version, name: String(name || (prevMeta && prevMeta.name) || sid),
    createdAt: (prevMeta && prevMeta.createdAt) || now,
    updatedAt: now,
    sha256: sha256(script),
    /* 运行模型由 kind 派生（automation=常驻，script/scene=一次性），不再单独存 longRunning。
     * 业务种类：跟随版本持久化；未传时从继承源继承，全新脚本缺省 automation。 */
    kind: kind != null ? kind : kindOf(inheritMeta),
    /* 脚本级超时覆盖：跟随版本持久化；未传时从继承源继承，未设置过则由 executor 用全局值 */
    runnerTimeoutMs: runnerTimeoutMs != null ? Number(runnerTimeoutMs)
      : ((inheritMeta && inheritMeta.runnerTimeoutMs) || undefined),
    /* 可重入触发（对齐 HA script 的 mode:restart）：重复按次触发时先停旧实例再启新实例。
     * 用于"再点一次即取消"的长任务脚本（如吸氧 30 分钟）；缺省 false 保持防重复保护。 */
    restartable: restartable == null ? !!(inheritMeta && inheritMeta.restartable) : !!restartable,
    /* 脚本级宿主覆盖：跟随版本持久化；未显式传入时从继承源（覆盖影子自身 / 最近一版）继承 */
    hostMode: (hostMode != null ? hostMode : (inheritMeta && inheritMeta.hostMode)) || undefined,
    channel: ch,
    revision: overwrite ? (Number(prevMeta.revision) || 1) + 1 : 1,
    ...(description ? { description: String(description) }
      : (prevMeta && prevMeta.description ? { description: prevMeta.description } : {})),
    /* icon 展示属性：显式传入合法值则更新；不传则从继承源继承（与 hostMode 同策略，迭代不丢图标） */
    ...(iconSvg ? { icon: iconSvg }
      : (inheritMeta && inheritMeta.icon ? { icon: inheritMeta.icon } : {})),
  };
  writeJson(path.join(dir, 'meta.json'), meta);
  return { ...get(sid, version), overwritten: overwrite };
}

/* 删除整个脚本：全部版本目录 + 运行日志目录 + 本脚本 ctx.local 命名空间。
 * 仅允许删除未运行脚本（executor.removeScript 已拦截运行实例）。
 * ctx.global 为共享命名空间（键无法归属到单个脚本）不清理；被删脚本写过的
 * global 键若无消费者，由使用者自行确认清理（如迁移场景的 waterHeater.*）。
 * 返回 { id }。 */
function removeScript(id) {
  const sid = safeId(id);
  if (!sid) throw new Error('脚本 id 非法');
  const dir = scriptDir(sid);
  if (!fs.existsSync(dir)) throw new Error('脚本不存在：' + sid);
  fs.rmSync(dir, { recursive: true, force: true });
  const rt = path.join(DATA, 'runtime', sid);
  if (fs.existsSync(rt)) fs.rmSync(rt, { recursive: true, force: true });
  context.removeScript(sid);
  return { id: sid };
}

/* 发布影子版本为正式版本：旧正式转归档；新正式 dryRun=false。
 * version 省略时取当前影子版本。返回 {version, previousProduction}。 */
function publish(id, version) {
  const sid = safeId(id);
  if (!sid) throw new Error('脚本 id 非法');
  normalizeChannels(sid);
  const targetV = version == null ? versionOfChannel(sid, 'shadow') : Number(version);
  if (targetV == null) throw new Error('没有可发布的影子版本');
  const targetMeta = readJson(path.join(versionDir(sid, targetV), 'meta.json'), null);
  if (!targetMeta) throw new Error('影子版本不存在：v' + targetV);
  if (channelOf(targetMeta) !== 'shadow') throw new Error('只能发布影子版本（v' + targetV + ' 当前为 ' + channelOf(targetMeta) + '）');

  const oldProd = versionOfChannel(sid, 'production');
  if (oldProd != null && oldProd !== targetV) {
    const pm = readJson(path.join(versionDir(sid, oldProd), 'meta.json'), null);
    if (pm) {
      pm.channel = 'archive';
      pm.archivedKind = 'published'; // 曾经上线，回滚候选（不再写 publishedAt）
      writeJson(path.join(versionDir(sid, oldProd), 'meta.json'), pm);
    }
  }
  targetMeta.channel = 'production';
  /* dryRun 不再落盘：正式身份由 channel=production 派生 */
  /* updatedAt 语义收窄：发布动作=影子转正式的时间，是唯一允许再次改写 updatedAt 的场景。
   * 不再写 publishedAt / status（运行状态由运行时维护）。 */
  targetMeta.updatedAt = new Date().toISOString();
  writeJson(path.join(versionDir(sid, targetV), 'meta.json'), targetMeta);
  return { version: targetV, previousProduction: oldProd != null && oldProd !== targetV ? oldProd : null, meta: get(sid, targetV).meta };
}

/* 清理版本。不可变对象（正式版）与工作副本（影子）都不允许删除：
 *   - production：线上真相源，删了就没有可回滚的锚点；
 *   - shadow：工作副本，直接覆盖修改即可，删掉会让下个提交复用版本号（破坏"版本号=候选版序号"）；
 *   - 正在运行：删除后运行实例失去落盘锚点（executor 层也会拦，这里双保险）。
 * 只允许清理 archive（历史）。返回被删版本信息。 */
function removeVersion(id, version) {
  const sid = safeId(id);
  if (!sid) throw new Error('脚本 id 非法');
  const v = Number(version);
  if (!Number.isInteger(v) || v < 1) throw new Error('版本号非法');
  const dir = versionDir(sid, v);
  if (!fs.existsSync(dir)) throw new Error('版本不存在：v' + v);
  const meta = readJson(path.join(dir, 'meta.json'), null);
  const ch = channelOf(meta || {});
  if (ch === 'production') throw new Error('正式版本不可删除（v' + v + '）：请先发布新版本使其自动归档');
  if (ch === 'shadow') throw new Error('影子版本是工作副本（v' + v + '），不能删除：直接重新提交即可覆盖修改');
  /* 运行守卫不在这里做：运行真相在 executor 内存（running map），
   * executor.removeVersion 已先行拦截 */
  fs.rmSync(dir, { recursive: true, force: true });
  try { fs.rmSync(logFile(sid, v), { force: true }); } catch (e) {}
  return { scriptId: sid, version: v, removed: true };
}

/* 回滚：把历史版本的内容读出来，作为**新版本**（shadow）提交。
 * 版本号继续递增、不改动通道 —— 是否上线仍要显式 publish（保留"回滚也要走影子验证"的门禁）。
 * 因为 production/archive 内容不可变，读到的就是当初上线的原文，不存在"回滚后内容漂移"。 */
function rollback(id, fromVersion) {
  const sid = safeId(id);
  if (!sid) throw new Error('脚本 id 非法');
  const v = Number(fromVersion);
  if (!Number.isInteger(v) || v < 1) throw new Error('回滚源版本号非法');
  const src = get(sid, v);
  if (!src) throw new Error('回滚源版本不存在：v' + v);
  const fromCh = channelOf(src.meta);
  if (fromCh === 'shadow') throw new Error('回滚源是当前影子版本（v' + v + '）：直接重新提交即可覆盖，无需回滚');
  const rec = submit(sid, {
    name: src.meta.name, script: src.script, flow: src.flow,
    kind: kindOf(src.meta),
    description: `回滚自 v${v}${fromCh === 'production' ? '（原正式版）' : '（历史归档版）'}`,
    newVersion: true,
  });
  return { ...rec, fromVersion: v, fromChannel: fromCh };
}

/* 状态迁移（2026-11-26 移除）：meta.json 不再存 status 字段——运行状态
 * （running/paused/error）由 executor 内存判定，重启恢复清单由
 * data/runtime/desired-running.json 维护，meta 里落状态只会造成频繁写盘与过期快照。
 * setStatus / VALID_TRANSITIONS / healStaleStatuses 一并退役：调用方（executor）
 * 已改为内存记录 + WS 广播，读方（列表/详情/版本接口）由 executor.runtimeStatus 合成。 */

/* 可读日志：data/runtime/<id>/v<n>.log */
function logFile(id, version) { return path.join(DATA, 'runtime', String(id), 'v' + Number(version) + '.log'); }

function readLogs(id, version, limit = 200) {
  /* M6：入口校验 id 与 version，避免 ../ 路径穿越跨脚本读日志。 */
  if (!safeId(id) || !Number.isInteger(version) || version < 1) return [];
  const file = logFile(id, version);
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => { try { return JSON.parse(line); } catch (e) { return { level: 'raw', message: line }; } });
  } catch (e) { return []; }
}

function appendLog(id, version, entry) {
  const file = logFile(id, version);
  ensureDataDir();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
}

/* 运行时日志定时清理（data/runtime/<id>/v<n>.log 为 JSON 行追加文件，天然只增不减）：
 * ① 超限截断：> MAX_LOG_BYTES 保留尾部 KEEP_BYTES（长驻脚本高频日志防无限膨胀）；
 * ② 孤儿删除：对应 data/scripts/<id>/v<n> 版本目录已不存在（版本被删/归档清理）→ 删日志；
 * ③ 空目录收尾：脚本下日志全删后移除空 <id> 目录。desired-running.json 不动。
 * 返回 { truncated, removed }；由 index.js 启动时 + 定时调用。 */
const RUNTIME_LOG_MAX_BYTES = 2 * 1024 * 1024;   // 单文件上限 2MB
const RUNTIME_LOG_KEEP_BYTES = 512 * 1024;       // 截断后保留尾部 512KB

function truncateTail(file, keepBytes) {
  const stat = fs.statSync(file);
  if (stat.size <= keepBytes) return false;
  const buf = Buffer.alloc(keepBytes);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, keepBytes, stat.size - keepBytes); }
  finally { fs.closeSync(fd); }
  let text = buf.toString('utf8');
  const nl = text.indexOf('\n');
  if (nl >= 0) text = text.slice(nl + 1);   // 扔掉截断产生的首条残行
  fs.writeFileSync(file, text);
  return true;
}

function cleanupRuntimeLogs() {
  const runtimeDir = path.join(DATA, 'runtime');
  const out = { truncated: 0, removed: 0 };
  let entries = [];
  try { entries = fs.readdirSync(runtimeDir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;                    // desired-running.json 等跳过
    const dir = path.join(runtimeDir, ent.name);
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) { continue; }
    for (const f of files) {
      const m = /^v(\d+)\.log$/.exec(f);
      if (!m) continue;
      const file = path.join(dir, f);
      const versionAlive = fs.existsSync(path.join(SCRIPTS_DIR, ent.name, 'v' + m[1]));
      if (!versionAlive) {
        try { fs.unlinkSync(file); out.removed += 1; } catch (e) {}
        continue;
      }
      try { if (truncateTail(file, RUNTIME_LOG_KEEP_BYTES)) out.truncated += 1; } catch (e) {}
    }
    try {
      const rest = fs.readdirSync(dir);
      if (rest.length === 0) fs.rmdirSync(dir);
    } catch (e) {}
  }
  return out;
}

function getMeta(id, version) {
  if (!safeId(id)) return null;
  return readJson(path.join(versionDir(id, version), 'meta.json'), null);
}

module.exports = {
  safeId, newScriptId, validateFlow, kindOf,
  list, listVersions, get, submit, publish, rollback, removeVersion, removeScript, getMeta,
  channelOf, normalizeChannels, versionOfChannel, detailedVersions,
  readLogs, appendLog, cleanupRuntimeLogs,
  EXECUTION_HOST_MODES,
};
