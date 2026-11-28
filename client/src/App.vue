<script setup>
/* 极简展示页：左侧脚本列表（由 AI 通过 MCP 创建），右侧只读流程预览。
 * 不提供手工提交/新建入口，不展示 HA 全量实体。 */
import { onMounted, computed, ref, watch, nextTick } from 'vue';
import { useAppStore } from './stores/app';
import { useScriptStore } from './stores/scripts';
import FlowPreview from './components/FlowPreview.vue';
import TopologyPanel from './components/TopologyPanel.vue';
import GlobalTopology from './components/GlobalTopology.vue';
import ScriptViewer from './components/ScriptViewer.vue';
import ConfigModal from './components/ConfigModal.vue';
import McpConfigModal from './components/McpConfigModal.vue';
import DiffViewer from './components/DiffViewer.vue';
import DeleteScriptModal from './components/DeleteScriptModal.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import { copyText } from './lib/clipboard';
/* 版本号直取项目根 package.json（Vite 原生支持 JSON 导入），不手写、不会与包版本漂移 */
import rootPkg from '../../package.json';

const appVersion = rootPkg.version || '';

const app = useAppStore();
const scripts = useScriptStore();

/* 全局提醒 toast：所有报错/提醒统一在中上部弹出，几秒后自动消失，不再占用侧栏/详情的内联位置 */
const toast = ref({ text: '', kind: 'error' });
let toastTimer = null;
function notify(text, kind = 'error') {
  toast.value = { text: String(text || ''), kind };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value.text = ''; }, 4200);
}

const showConfig = ref(false);
const showMcpConfig = ref(false);
const showDiff = ref(false);
const delTarget = ref(null);   // 待删除脚本（删除弹窗数据源）
function onScriptDeleted(id) {
  /* 删除成功后刷新列表；删的是当前打开的脚本则清空右侧详情 */
  if (scripts.current && scripts.current.id === id) scripts.current = null;
  scripts.load();
}
/* 点击左上角标识（图标+文字+版本号）返回全局运行拓扑：清空当前选中脚本即可，
 * 右侧 main 的 v-else 分支会渲染 GlobalTopology。原地点击不占比任何副作用。 */
function goTopology() {
  scripts.current = null;
}
const actionBusy = ref(false);

/* 自定义确认弹窗：替代 window.confirm；askConfirm 返回 Promise，true=确定 false=取消 */
const dialog = ref({ open: false, title: '', message: '', confirmText: '确定', danger: false });
let dialogResolve = null;
function askConfirm(opts) {
  if (dialog.value.open) return Promise.resolve(false);
  return new Promise((resolve) => {
    dialogResolve = resolve;
    Object.assign(dialog.value, opts, { open: true });
  });
}
function answerConfirm(ok) {
  dialog.value.open = false;
  const resolve = dialogResolve;
  dialogResolve = null;
  if (resolve) resolve(ok);
}

const haLabel = computed(() => {
  const m = { connected: '已连接', disconnected: '未连接', reconnecting: '重连中', error: '鉴权失败', demo: '演示模式' };
  return m[app.haStatus] || app.haStatus;
});

/* 当前打开版本的角色：meta.channel 是唯一真相（服务端 store.channelOf 派生），
 * 不再用 shadowVersion/productionVersion 版本号比对——发布切换窗口内比对表过期会判错 */
const currentChannel = computed(() => scripts.current?.meta?.channel || null);
const CHANNEL_TEXT = { shadow: '影子版本', production: '正式版本', archive: '归档版本' };
function channelText(ch) { return CHANNEL_TEXT[ch] || ch || '未知'; }

/* 影子 + 正式并存才提供 diff（升级后的典型状态：正式 vN → 影子 vM） */
const canDiff = computed(() => scripts.shadowVersion != null && scripts.productionVersion != null);

/* 状态徽标文案（运行状态由 executor 内存合成，无 draft；switching 是切模式的瞬态） */
const STATUS_TEXT = {
  stopped: '已停止', running: '运行中', paused: '已暂停', error: '异常', timeout: '超时', switching: '切换中',
};
function statusText(s) { return STATUS_TEXT[s] || s || '未知'; }

/* 当前打开版本的运行实例（正式/影子各至多一个，按版本号锁定） */
const currentInstance = computed(() => {
  if (!scripts.current) return null;
  return scripts.runningVersions.find((x) => x.version === scripts.current.version) || null;
});
/* 当前实例的验证方式：跟随真实 or 仿真。无实例为 null */
const verifyMode = computed(() => (currentInstance.value ? (currentInstance.value.verifyMode || 'follow') : null));
/* 只有影子实例在跑时才能切验证方式：正式实例固定真实下发，没有仿真概念（§2.1） */
const canSwitchVerify = computed(() => currentChannel.value === 'shadow' && !!currentInstance.value);
const switchBusy = ref(false);
async function toggleVerifyMode() {
  if (switchBusy.value) return;
  const target = verifyMode.value === 'simulate' ? 'follow' : 'simulate';
  switchBusy.value = true;
  try {
    await scripts.switchVerifyMode(scripts.current.id, target);
    notify(target === 'simulate'
      ? '已进入仿真：虚拟实体/虚拟时钟，不接触真实设备；发布前仍需切回影子模式真实跑一次'
      : '已切回影子模式：影子实例恢复真实 HA 数据与真实时钟', 'warn');
  } catch (e) { notify(e.message); }
  finally { switchBusy.value = false; }
}

/* 左侧列表徽标：运行真相优先，并标明是正式还是影子实例在跑 */
function listBadge(s) {
  const rvs = s.runningVersions || [];
  const sh = rvs.find((r) => r.mode === 'shadow');
  const hasP = rvs.some((r) => r.mode === 'production');
  /* 仿真也是影子身份（dryRun 仍为 true），单看 mode 分不出来，必须看实例上的 verifyMode */
  if (sh && sh.verifyMode === 'simulate') {
    return hasP
      ? { cls: 'sim-run', text: '仿真中', title: '影子实例在仿真世界运行（同时有正式实例在真实下发）' }
      : { cls: 'sim-run', text: '仿真中', title: '影子实例在仿真世界运行：虚拟实体/虚拟时钟，不接触真实设备' };
  }
  if (hasP && sh) return { cls: 'running', text: '运行中', title: '正式与影子实例都在跑' };
  if (hasP) return { cls: 'running', text: '运行中', title: '正式实例在跑（真实下发）' };
  if (sh) return { cls: 'shadow-run', text: '运行中', title: '影子实例在跑（跟随真实 HA，只记日志不下发）' };
  /* 运行真相 = runningVersions；status 由服务端实时合成，这里兜底仅防旧版服务端 */
  const eff = (rvs.length === 0 && ['running', 'paused'].includes(s.status)) ? 'stopped' : (s.status || 'stopped');
  return { cls: eff, text: statusText(eff), title: '' };
}

/* 运行实例只在版本条上标注（正式与影子可各有一个，互不影响） */
function runningOf(v) { return scripts.runningVersions.find((x) => x.version === v.version); }
/* 版本条状态文案：有实例显示运行中；无实例时 running/paused 属服务端异常兜底，按已停止展示 */
function versionStatus(v) {
  if (runningOf(v)) return { cls: 'running', text: '运行中' };
  const st = ['running', 'paused'].includes(v.status) ? 'stopped' : (v.status || 'stopped');
  return { cls: st, text: statusText(st) };
}

/* 左侧列表副标题：正式 / 影子（含改版次数），运行状态由徽标与版本条体现 */
function subtitle(s) {
  if (s.description) return s.description;
  const parts = [];
  if (s.productionVersion) parts.push(`正式 v${s.productionVersion}`);
  if (s.shadowVersion) parts.push(`影子 v${s.shadowVersion}${s.shadowRevision > 1 ? ` · 改${s.shadowRevision}` : ''}`);
  return parts.length ? parts.join(' · ') : '尚无版本';
}

/* 列表按运行模型分两组：常驻自动化（kind=automation）与动作/场景（script/scene，一次性触发）。
 * 运行模型由 kind 派生（与执行器行为一致），不再有独立的 longRunning 字段。 */
const liveScripts = computed(() => scripts.list.filter((s) => s.kind === 'automation'));
const onceScripts = computed(() => scripts.list.filter((s) => s.kind !== 'automation'));
/* 一次性动作平时没有常驻实例：有正式版才"就绪"（按次触发、跑完自动结束）；
 * 只有影子/无版本时是"待发布"——避免未发布就显示可用的误导。 */
function onceBadge(s) {
  if (s.productionVersion) return { cls: 'ready', text: '就绪', title: '正式版本已发布：按次触发，短暂运行后自动结束' };
  return { cls: 'pending', text: '待发布', title: '暂无正式版本：可先触发影子版本验证（写操作只记日志），通过后发布正式版' };
}

/* 脚本 icon（meta.json 的 SVG 源码）：服务端已做提交侧校验，前端再净一道 ——
 * 只放行完整 <svg>…</svg> 且不含脚本注入/事件属性/外链，失败回退默认 ⌁。 */
function safeIcon(src) {
  if (typeof src !== 'string') return null;
  const s = src.trim();
  if (!s || s.length > 8192) return null;
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) return null;
  if (/<script|<iframe|<foreignObject|<use\b|<image\b|on\w+\s*=|javascript:|data:text\/html/i.test(s)) return null;
  return s;
}

/* 点击复制脚本 id（AI 提交 MCP 调用时要用这个 id）；复用公共剪贴板库，按其返回值提示 */
const copiedId = ref('');
async function copyId(id) {
  const ok = await copyText(id);
  if (!ok) return;
  copiedId.value = id;
  setTimeout(() => { if (copiedId.value === id) copiedId.value = ''; }, 1500);
}

/* 删除整个脚本：打开自定义确认弹窗（需输入脚本 id），确认逻辑在 DeleteScriptModal 内 */
function removeScript(s) { delTarget.value = s; }

onMounted(() => {
  scripts.load();
});

/* 运行日志：默认跟随最新；上翻查看历史时暂停跟随，可一键回到底部。
 * 跟随状态放 store（pushLog 裁剪依赖它：上翻看历史时不吃头部行）。 */
const logBox = ref(null);
function scrollLogsToBottom() {
  const el = logBox.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  scripts.followLogs = true;
}
async function onLogScroll() {
  const el = logBox.value;
  if (!el) return;
  scripts.followLogs = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  /* 顶部 40px 内且还有更早的：加载上一页。prepend 会把内容顶下去，
   * 必须按加载前后 scrollHeight 差值补偿 scrollTop，否则视口会跳。 */
  if (el.scrollTop < 40 && scripts.logsHasMore && !scripts.logsLoadingOlder && scripts.current) {
    const before = el.scrollHeight;
    const loaded = await scripts.loadOlderLogs(scripts.current.id, scripts.current.version, 100, scripts.logsSource);
    if (!loaded) return;
    await nextTick();
    if (logBox.value !== el) return; // 期间切换了脚本/版本，DOM 已换，不补
    el.scrollTop += el.scrollHeight - before;
  }
}
watch([() => scripts.current?.id, () => scripts.current?.version, () => scripts.logs.length],
  ([id, version], [oldId, oldVersion]) => {
    if (id !== oldId || version !== oldVersion) scripts.followLogs = true; // 切换脚本/版本重新跟随最新
    if (scripts.followLogs) nextTick(scrollLogsToBottom);
  });
function onLogToggle(e) {
  if (e.target.open) nextTick(scrollLogsToBottom); // details 展开时先落到底
}

/* 一次性脚本（script/scene）没有常驻实例概念，按钮走按次触发。
 * 有正式版走正式（Home 面板语义不变）；只有影子时降级触发影子版本——
 * 影子实例由执行器硬隔离：设备写只记日志，不会改动 HA 实体。 */
const isOnceScript = computed(() => scripts.current?.meta?.kind !== 'automation');
async function runOnce() {
  try {
    const fallbackShadow = !scripts.productionVersion && scripts.shadowVersion != null;
    const r = await scripts.trigger(scripts.current.id, fallbackShadow ? 'shadow' : undefined);
    if (r.mode === 'shadow') notify('影子触发：设备写操作只记日志，不会改动 HA 实体', 'warn');
    if (r.devMode) notify('开发模式：本次触发只记日志，不下发真实设备', 'warn');
  } catch (e) { notify(e.message); }
}

async function start() {
  try { await scripts.start(scripts.current.id, scripts.current.version); }
  catch (e) { notify(e.message); }
}
/* 停止 = 只停**当前打开版本**的实例：正式+影子并行时想停另一个，
 * 在版本条点开那个版本再停（避免一次停掉两个实例，与"互不影响"心智一致） */
async function stop() {
  try { await scripts.stop(scripts.current.id, scripts.current.version); }
  catch (e) { notify(e.message); }
}

/* 发布影子版本为正式版本，自定义弹窗二次确认（开发模式只验证发布流程，不接管设备） */
async function publish(version) {
  if (actionBusy.value) return;
  const effect = app.devMode
    ? '当前为开发模式：发布后成为正式版本、实例可自动恢复，但脚本的 HA 写仍只记日志、不会真实下发设备（验证发布流程用）。'
    : '发布后该版本将按其脚本定义真实下发 HA 控制。';
  const ok = await askConfirm({
    title: '发布正式版本',
    message: '即将把影子版本 v' + version + ' 发布为【正式版本】。\n\n' + effect + '\n\n旧正式版本会被归档，请确认影子逻辑已验证无误。',
    confirmText: '确认发布',
  });
  if (!ok) return;
  actionBusy.value = true;
  try { await scripts.publish(scripts.current.id, version); }
  catch (e) { notify(e.message); }
  finally { actionBusy.value = false; }
}

/* 清理版本（同样走自定义弹窗）。只有归档版本可删 */
async function removeVersion(version) {
  if (actionBusy.value) return;
  const ok = await askConfirm({
    title: '删除归档版本',
    message: '确定删除归档版本 v' + version + ' 吗？该版本的脚本与日志会被永久删除。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  actionBusy.value = true;
  try { await scripts.deleteVersion(scripts.current.id, version); }
  catch (e) { notify(e.message); }
  finally { actionBusy.value = false; }
}

/* 回滚：读历史版本原文 → 提交为新的影子版本（不自动上线） */
async function rollbackTo(version) {
  if (actionBusy.value) return;
  const ok = await askConfirm({
    title: '回滚到 v' + version,
    message: '将读取 v' + version + ' 的脚本与流程原文，提交为一个【新的影子版本】（版本号继续递增，不会自动上线）。\n\n之后请先启动影子验证，确认无误再发布为正式版本。',
    confirmText: '创建回滚版本',
  });
  if (!ok) return;
  actionBusy.value = true;
  try { await scripts.rollback(scripts.current.id, version); }
  catch (e) { notify(e.message); }
  finally { actionBusy.value = false; }
}
</script>

<template>
  <div class="app">
    <header class="top">
      <div class="brand" @click="goTopology" title="返回全局运行拓扑" role="button" tabindex="0" @keydown.enter="goTopology" @keydown.space.prevent="goTopology">
        <img class="logo" src="/favicon.svg" alt="居控中枢">居控中枢<span v-if="appVersion" class="version">v{{ appVersion }}</span>
      </div>
      <div class="status">
        <span class="dot" :class="app.haStatus"></span> HA {{ haLabel }}
        <span class="sep">·</span>
        <span class="dot" :class="app.wsConnected ? 'connected' : 'disconnected'"></span> WS {{ app.wsConnected ? '已连' : '断开' }}
        <button class="cfg-btn" @click="showConfig = true" title="HA 连接配置">⚙ 配置</button>
        <button class="cfg-btn" @click="showMcpConfig = true" title="复制 MCP 接入配置">MCP 接入</button>
        <button class="theme-btn" @click="app.toggleTheme()" :title="app.dark ? '切回亮色模式' : '切到暗色模式'">
          <svg v-if="app.dark" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="4.5" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        </button>
      </div>
    </header>

    <!-- 开发模式横幅：只拦脚本发起的 HA 写，身份/上下文/恢复/发布均按通道语义，防止误以为本地面板在控制设备 -->
    <div v-if="app.devMode" class="dev-banner">🛠 开发模式：所有HA调用都只记日志不下发，包括正式脚本——真实设备控制权在正式环境</div>

    <ConfigModal :open="showConfig" @close="showConfig = false" />
    <McpConfigModal :open="showMcpConfig" @close="showMcpConfig = false" />
    <DiffViewer :open="showDiff" :script-id="scripts.current?.id || ''" :from="scripts.productionVersion || 0"
      :to="scripts.shadowVersion || 0" @close="showDiff = false" />
    <DeleteScriptModal :open="!!delTarget" :script="delTarget" @close="delTarget = null" @deleted="onScriptDeleted" />
    <ConfirmDialog
      :open="dialog.open" :title="dialog.title" :message="dialog.message"
      :confirm-text="dialog.confirmText" :danger="dialog.danger" :busy="actionBusy"
      @confirm="answerConfirm(true)" @cancel="answerConfirm(false)" />

    <!-- MCP 调用提示横条：顶部居中，与 studio 一致；长时间无活动自动消失 -->
    <transition name="mcp-fade">
      <div v-if="app.mcp.active" class="mcp-bar" :class="{ off: !app.mcp.connected, busy: app.mcp.busy }">
        <span class="mcp-dot"></span>
        <span class="mcp-text">{{ app.mcp.text }}</span>
      </div>
    </transition>

    <!-- 全局提醒 toast：中上部弹出，覆盖所有报错/提醒（错误红、提醒橙），4.2 秒自动消失 -->
    <transition name="toast-fade">
      <div v-if="toast.text" class="toast" :class="toast.kind" role="alert">{{ toast.text }}</div>
    </transition>

    <div class="body">
      <aside class="side">
        <div class="list">
          <template v-for="group in [{ key: 'live', label: '常驻自动化', items: liveScripts },
                                      { key: 'once', label: '动作与场景（触发即走）', items: onceScripts }]" :key="group.key">
            <div v-if="group.items.length" class="grp-title">{{ group.label }} <span class="grp-count">{{ group.items.length }}</span></div>
            <button v-for="s in group.items" :key="s.id" class="item"
              :class="{ on: scripts.current?.id === s.id }" @click="scripts.open(s.id)">
              <span class="item-ic" :class="(s.runningVersions || []).length ? 'live' : ''">
                <span v-if="safeIcon(s.icon)" class="ic-svg" v-html="safeIcon(s.icon)"></span>
                <template v-else>⌁</template>
              </span>
              <span class="item-body">
                <span class="item-top">
                  <span class="item-name">{{ s.name }}</span>
                  <span v-if="group.key === 'once'" class="badge" :class="onceBadge(s).cls" :title="onceBadge(s).title">{{ onceBadge(s).text }}</span>
                  <span v-else class="badge" :class="listBadge(s).cls" :title="listBadge(s).title">{{ listBadge(s).text }}</span>
                </span>
                <span class="item-sub">{{ subtitle(s) }}</span>
                <span class="item-meta">
                  <span class="sid-tag" :class="{ ok: copiedId === s.id }" :title="copiedId === s.id ? '已复制' : '点击复制脚本 id'"
                    @click.stop="copyId(s.id)">{{ copiedId === s.id ? '已复制 ✓' : s.id }}</span>
                  <span v-if="s.productionVersion" class="mode-tag live" :title="`正式版本 v${s.productionVersion}`">v{{ s.productionVersion }}</span>
                  <span v-if="s.shadowVersion" class="mode-tag shadow" :title="`影子版本 v${s.shadowVersion}`">v{{ s.shadowVersion }}</span>
                  <span v-if="!s.productionVersion && !s.shadowVersion" class="mode-tag shadow">待验证</span>
                  <button v-if="!(s.runningVersions || []).length" class="del-btn" title="删除该脚本的全部版本（运行中不可删）"
                    @click.stop="removeScript(s)">删除</button>
                </span>
              </span>
            </button>
          </template>
          <div v-if="!scripts.list.length" class="empty">等待 AI 提交脚本…</div>
        </div>
      </aside>

      <main class="main" :class="{ 'gt-full': !scripts.current }">
        <template v-if="scripts.current">
          <div class="detail-head">
            <div class="dh-left">
              <span v-if="safeIcon(scripts.current.meta?.icon)" class="dh-ic" v-html="safeIcon(scripts.current.meta?.icon)"></span>
              <h2>{{ scripts.current.meta?.name || scripts.current.id }}</h2>
              <span class="sid-tag" :class="{ ok: copiedId === scripts.current.id }" :title="copiedId === scripts.current.id ? '已复制' : '点击复制脚本 id'"
                @click="copyId(scripts.current.id)">{{ copiedId === scripts.current.id ? '已复制 ✓' : scripts.current.id }}</span>
              <span class="badge" :class="scripts.current.status">{{ statusText(scripts.current.status) }}</span>
              <span v-if="verifyMode === 'simulate'" class="badge sim-run"
                title="当前实例运行在仿真世界：实体/上下文/时钟都是虚拟数据，设备写只记写意图，不接触真实 HA">
                仿真验证
              </span>
              <span v-if="scripts.current.meta?.channel === 'shadow' && scripts.current.meta?.revision > 1"
                class="channel-badge rev" title="影子版本可原地修改：每次重新提交版本号不变，改版次数 +1">
                改{{ scripts.current.meta.revision }}次
              </span>
            </div>
            <div class="dh-actions">
              <!-- 验证方式切换：只对影子实例开放（正式实例固定真实下发）。切换 = 暂停→重启，
                   不是热切换，所以按钮明确提示会重启实例 -->
              <button v-if="canSwitchVerify" class="mode-switch-btn" :disabled="switchBusy || scripts.current.status === 'switching'"
                :title="verifyMode === 'simulate'
                  ? '切回跟随真实：暂停仿真实例，以真实 HA 数据与真实时钟重启影子（仿真结果不能作为上线依据）'
                  : '进入仿真：暂停影子实例，以虚拟实体/虚拟时钟重启，可逐步注入状态验证逻辑（设备写只记意图）'"
                @click="toggleVerifyMode">
                {{ (switchBusy || scripts.current.status === 'switching') ? '切换中…' : (verifyMode === 'simulate' ? '⇄ 切回影子模式' : '⇄ 进入仿真') }}
              </button>
              <button v-if="canDiff" class="diff-btn" :disabled="actionBusy"
                :title="`对比正式 v${scripts.productionVersion} 与影子 v${scripts.shadowVersion} 的脚本变更`"
                @click="showDiff = true">
                ⇄ 对比变更
              </button>
              <button
                v-if="currentChannel === 'shadow' && scripts.shadowVersion === scripts.current.version"
                class="publish-btn" :disabled="actionBusy" @click="publish(scripts.current.version)">
                ⇧ 发布为正式版本
              </button>
              <template v-if="isOnceScript">
                <button class="primary" :disabled="actionBusy" @click="runOnce">执行一次</button>
                <button v-if="scripts.current.running" class="danger" @click="stop">取消执行</button>
              </template>
              <template v-else>
                <button v-if="!scripts.current.running" class="primary" @click="start">启动</button>
                <button v-else class="danger" @click="stop">停止</button>
              </template>
            </div>
          </div>

          <!-- 版本管理：影子（可改，唯一）/ 正式（不可变，唯一）/ 归档（分曾上线 / 试错废弃） -->
          <div class="version-bar">
            <span class="vb-title">版本</span>
            <div class="vb-list">
              <div v-for="v in scripts.versions" :key="v.version" class="vb-item"
                :class="[v.channel, { on: scripts.current.version === v.version }]"
                @click="scripts.open(scripts.current.id, v.version)">
                <span class="vb-ver">v{{ v.version }}</span>
                <span class="vb-ch" :class="v.channel">{{ channelText(v.channel) }}</span>
                <span v-if="v.channel === 'shadow' && v.revision > 1" class="vb-tag" title="影子可原地修改：版本号不变，改版次数递增">改{{ v.revision }}</span>
                <span v-if="v.channel === 'archive' && v.archivedKind === 'published'" class="vb-tag live" title="曾经上线过的版本（回滚候选）">曾上线</span>
                <span v-if="runningOf(v)" class="vb-tag" :class="runningOf(v).verifyMode === 'simulate' ? 'sim' : 'run'"
                  :title="runningOf(v).verifyMode === 'simulate' ? '仿真中：虚拟实体/虚拟时钟，不接触真实设备' : (runningOf(v).mode === 'shadow' ? '影子实例在跑（跟随真实，只记日志）' : '正式实例在跑（真实下发）')">
                  {{ runningOf(v).verifyMode === 'simulate' ? '仿真中' : '运行中' }}
                </span>
                <span v-if="!runningOf(v)" class="vb-status" :class="versionStatus(v).cls">{{ versionStatus(v).text }}</span>
                <button v-if="v.channel === 'archive' && v.archivedKind === 'published'" class="vb-rb"
                  :disabled="actionBusy" title="回滚到此版本（内容作为新影子版本提交，不会自动上线）"
                  @click.stop="rollbackTo(v.version)">↶</button>
                <button v-if="v.channel === 'archive'" class="vb-del" :disabled="actionBusy"
                  title="清理此归档版本" @click.stop="removeVersion(v.version)">×</button>
              </div>
            </div>
          </div>

          <div class="mode-note" :class="currentChannel === 'production' ? 'live' : 'shadow'">
            <template v-if="currentChannel === 'production'">● 正式版本：{{ app.devMode ? '开发模式下脚本 HA 写只记日志不下发（验证用），不接管设备' : '按其脚本定义真实下发 HA 控制' }}；内容不可变，要改必须提交新影子再发布</template>
            <template v-else-if="currentChannel === 'shadow'">● 影子版本：写操作只记日志、不下发（读操作正常）。这是可反复修改的工作副本——重新提交会原地覆盖本版本（版本号不变、改版次数+1），改完需重新启动才生效</template>
            <template v-else>● 归档版本：历史版本，不可修改；「曾上线」的可一键回滚为新影子版本</template>
          </div>
          <!-- 仿真提示条：与影子提示并列，强调「世界是虚拟的、结果不能直接当上线依据」 -->
          <div v-if="verifyMode === 'simulate'" class="mode-note sim">
            ● 仿真实例：实体状态、上下文与时钟都来自虚拟世界，设备写只记写意图、不接触真实 HA；日志写入独立的
            <code>.sim.log</code>。仿真只验证流程与时序——设备不响应、失败、延迟等异常分支不模拟，需切回「影子模式」用真实设备验证。仿真通过 ≠ 线上可用，发布前请切回「影子模式」实跑一次。
          </div>
          <FlowPreview />
          <TopologyPanel />
          <ScriptViewer />
          <details class="log-box" @toggle="onLogToggle">
            <summary><span class="panel-title"><span class="panel-chev"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>运行日志<span v-if="scripts.logsSource === 'sim'" class="log-src sim" title="仿真实例的日志：写在独立的 v&lt;n&gt;.sim.log，不是真实运行记录">仿真</span></span><button v-if="!scripts.followLogs" class="log-follow" @click.stop="scrollLogsToBottom">↓ 回到最新</button></summary>
            <div ref="logBox" class="logs" @scroll="onLogScroll">
              <div v-if="scripts.logsLoadingOlder" class="log-more">加载更早…</div>
              <div v-else-if="!scripts.logsHasMore && scripts.logs.length" class="log-more">没有更早的日志</div>
              <div v-for="(l, i) in scripts.logs" :key="i" class="log" :class="l.level">
                <span class="ts">{{ scripts.logsSource === 'sim' && l.at != null ? '+' + (l.at / 1000).toFixed(1) + 's' : new Date(l.ts).toLocaleTimeString() }}</span>
                <span class="lv">{{ l.level }}</span>
                <span class="msg">{{ l.message }}</span>
              </div>
              <div v-if="!scripts.logs.length" class="empty">暂无日志</div>
            </div>
          </details>
        </template>

        <!-- 未选中脚本：全局运行拓扑（正式通道）。不轮询，手动刷新；选中左侧脚本即切回详情 -->
        <GlobalTopology v-else />
      </main>
    </div>
  </div>
</template>
