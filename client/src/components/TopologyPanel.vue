<script setup>
/* 运行时拓扑面板：展示 executor 在真实拦截点观测到的实体读写与上下文读写。
 * 数据来自 GET /api/script/:id/topology，按 shadow/production 分组。
 * 关键口径：这是"运行一段时间后逐步积累"的真实观测，不是静态解析；
 * 脚本没跑过或只跑过没触发的分支 → 对应项为空，不代表脚本不用它们。 */
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { useScriptStore } from '../stores/scripts';
import TopologyGraph from './TopologyGraph.vue';
import LiveValueTip from './LiveValueTip.vue';
import { useLiveTip } from '../lib/live-tip';

const store = useScriptStore();
const detailsEl = ref(null);
const data = ref(null);
const loading = ref(false);
const refreshing = ref(false);
const detailsOpen = ref(false);
/* 视图口径：列表每 5s 自动刷新；图形是坐标驱动的，自动刷新会跳变，改为手动刷新 */
const view = ref('list');

const REFRESH_MS = 5000;

/* 当前版本通道决定默认展示哪一组；没有该组数据时给空结构 */
const mode = computed(() => {
  const ch = store.current?.meta?.channel;
  return ch === 'production' ? 'production' : 'shadow';
});
const group = computed(() => data.value?.topology?.[mode.value] || null);

/* 实体展示名由接口根据 HA 内存缓存补充；没有 friendly_name 时回退 entity_id。
 * 映射不落盘，HA 重命名后下一次自动刷新即可反映。 */
const entityLabels = computed(() => data.value?.entityLabels || {});
const scriptNames = computed(() => data.value?.scriptNames || {});
function entityLabel(id) {
  const eid = String(id || '');
  return entityLabels.value[eid]?.label || eid;
}

let timer = null;
let seq = 0;
let pendingId = null;

async function load(background = false) {
  const id = store.current?.id;
  if (!id) {
    data.value = null;
    loading.value = false;
    refreshing.value = false;
    return;
  }
  /* 同一脚本的请求不重叠；切换脚本时允许新请求立即发出，旧响应由 seq 丢弃 */
  if (pendingId === id) return;
  pendingId = id;
  const mySeq = ++seq;
  const requestedId = id;
  if (!background && !data.value) loading.value = true;
  if (background) refreshing.value = true;
  try {
    const res = await fetch(`/api/script/${encodeURIComponent(id)}/topology`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (mySeq !== seq || store.current?.id !== requestedId) return;
    data.value = json;
  } catch (e) {
    /* 后台刷新失败保留上一次结果；首次加载失败才清空 */
    if (mySeq === seq && !background) data.value = null;
  } finally {
    if (mySeq === seq) {
      loading.value = false;
      refreshing.value = false;
    }
    if (pendingId === id) pendingId = null;
  }
}

function stopPolling() {
  if (timer) { clearInterval(timer); timer = null; }
}

function startPolling() {
  stopPolling();
  if (!store.current?.id) return;
  /* 面板折叠、页面不可见、或当前是图形视图时不轮询；重新展开/回到页面/切回列表会立即补一次 */
  timer = setInterval(() => {
    if (document.hidden || !detailsOpen.value || view.value !== 'list') return;
    load(true);
  }, REFRESH_MS);
}

function onToggle(event) {
  detailsOpen.value = !!event.target.open;
  if (detailsOpen.value && !document.hidden) load(!!data.value);
}

function onVisibility() {
  if (!document.hidden && detailsOpen.value) load(!!data.value);
}

function setView(next) {
  if (view.value === next) return;
  view.value = next;
  /* 切到图形且还没数据时拉一次；已有数据复用，不重新请求（避免坐标重排） */
  if (next === 'graph' && !data.value) load(false);
}

function manualRefresh() {
  load(!!data.value);
}

onMounted(() => {
  detailsOpen.value = !!detailsEl.value?.open;
  document.addEventListener('visibilitychange', onVisibility);
  startPolling();
});

onBeforeUnmount(() => {
  seq++;
  stopPolling();
  document.removeEventListener('visibilitychange', onVisibility);
});

/* ---------- hover 实时取值 ----------
 * 每次鼠标进入条目都重新请求，不缓存；公共 useLiveTip 驱动（列表不加轮询，靠 5s 面板刷新）。 */
const { tip, open, move, hide } = useLiveTip();

watch(() => store.current?.id, () => {
  data.value = null;
  load(false);
  startPolling();
}, { immediate: true });
</script>

<template>
  <details ref="detailsEl" class="topo-box" @toggle="onToggle">
    <summary>
      <span class="tb-title panel-title"><span class="panel-chev"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>运行拓扑</span>
      <span class="tb-tools" @click.stop>
        <span class="tb-switch">
          <button class="tb-view" :class="{ on: view === 'list' }" @click="setView('list')">列表</button>
          <button class="tb-view" :class="{ on: view === 'graph' }" @click="setView('graph')">图形</button>
        </span>
        <button v-if="view === 'graph'" class="tb-refresh" :disabled="refreshing" title="手动刷新拓扑" @click="manualRefresh">{{ refreshing ? '刷新中…' : '↻ 刷新' }}</button>
        <span class="tb-meta">{{ view === 'list' ? '每 5 秒自动刷新' : '手动刷新 · Ctrl+滚轮缩放' }}</span>
      </span>
    </summary>
    <div class="tb-body" :class="{ 'tb-body-graph': view === 'graph' }">
      <div v-if="view === 'list'" class="tb-note">脚本运行后逐步记录真实发生的读写；未触发的分支不会显示，空列表不代表脚本不用。</div>
      <div v-if="loading && !data" class="tb-empty">加载中…</div>
      <template v-else-if="group">
        <TopologyGraph v-if="view === 'graph'"
          :group="group" :entity-labels="entityLabels" :script-names="scriptNames" :mode="mode"
          :script-name="store.current?.meta?.name || store.current?.id"
          :script-id="store.current?.id || ''" />
        <template v-else>
          <div class="tb-section">
            <div class="tb-head"><span class="tb-dot read"></span>依赖实体（读取 / 订阅）<span class="tb-count">{{ group.reads?.length || 0 }}</span></div>
            <div v-if="group.reads?.length" class="tb-items">
              <code v-for="e in group.reads" :key="e" class="tb-item read"
                @mouseenter="open($event, { kind: 'entity', id: e, scriptId: store.current?.id, mode: mode.value })" @mousemove="move" @mouseleave="hide">{{ entityLabel(e) }}</code>
            </div>
            <div v-else class="tb-empty">暂无观测</div>
          </div>
          <div class="tb-section">
            <div class="tb-head"><span class="tb-dot ctx-read"></span>读取上下文（get / watch）<span class="tb-count">{{ group.contextReads?.length || 0 }}</span></div>
            <div v-if="group.contextReads?.length" class="tb-items">
              <code v-for="c in group.contextReads" :key="c" class="tb-item ctx-read"
                @mouseenter="open($event, { kind: 'context', id: c, scriptId: store.current?.id, mode: mode.value })" @mousemove="move" @mouseleave="hide">{{ c }}</code>
            </div>
            <div v-else class="tb-empty">暂无观测</div>
          </div>
          <div class="tb-section">
            <div class="tb-head"><span class="tb-dot write"></span>修改实体（HA 服务调用）<span class="tb-count">{{ group.writes?.length || 0 }}</span></div>
            <div v-if="group.writes?.length" class="tb-items">
              <code v-for="e in group.writes" :key="e" class="tb-item write"
                @mouseenter="open($event, { kind: 'entity', id: e, scriptId: store.current?.id, mode: mode.value })" @mousemove="move" @mouseleave="hide">{{ entityLabel(e) }}</code>
            </div>
            <div v-else class="tb-empty">暂无观测（影子模式写操作被拦截，不会出现在此）</div>
            <div v-if="group.services?.length" class="tb-services">
              <span>服务：</span><code v-for="s in group.services" :key="s" class="tb-svc">{{ s }}</code>
            </div>
          </div>
          <div class="tb-section">
            <div class="tb-head"><span class="tb-dot ctx"></span>写入上下文<span class="tb-count">{{ group.contexts?.length || 0 }}</span></div>
            <div v-if="group.contexts?.length" class="tb-items">
              <code v-for="c in group.contexts" :key="c" class="tb-item ctx"
                @mouseenter="open($event, { kind: 'context', id: c, scriptId: store.current?.id, mode: mode.value })" @mousemove="move" @mouseleave="hide">{{ c }}</code>
            </div>
            <div v-else class="tb-empty">暂无观测</div>
          </div>
          <div class="tb-section">
            <div class="tb-head"><span class="tb-dot call"></span>调用脚本（ctx.call）<span class="tb-count">{{ group.calls?.length || 0 }}</span></div>
            <div v-if="group.calls?.length" class="tb-items">
              <code v-for="t in group.calls" :key="t" class="tb-item call">{{ scriptNames[t] || t }}</code>
            </div>
            <div v-else class="tb-empty">暂无观测</div>
          </div>
          <div class="tb-section">
            <div class="tb-head"><span class="tb-dot dep"></span>依赖脚本状态（status / require / watch）<span class="tb-count">{{ group.taskDeps?.length || 0 }}</span></div>
            <div v-if="group.taskDeps?.length" class="tb-items">
              <code v-for="t in group.taskDeps" :key="t" class="tb-item dep">{{ scriptNames[t] || t }}</code>
            </div>
            <div v-else class="tb-empty">暂无观测</div>
          </div>
        </template>
      </template>
      <div v-else class="tb-empty">该脚本尚未运行，暂无拓扑观测数据</div>
    </div>
    <!-- hover 实时取值浮层：公共组件，fixed 定位不受 details 折叠/滚动裁剪 -->
    <LiveValueTip :tip="tip" />
  </details>
</template>

<style scoped>
/* 使用项目真实主题变量（style.css）：右侧面板是 --surface，这里用 --surface2 拉开层次 */
.topo-box { border: 1px solid var(--line); border-radius: 10px; margin: 12px 0; background: var(--surface2); }
/* 标题栏与脚本源码/运行日志面板一致用 --surface，展开内容才用 --surface2 区分 */
.topo-box > summary { cursor: pointer; padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; list-style: none; background: var(--surface); border-bottom: 1px solid var(--line); border-radius: 9px 9px 0 0; }
.topo-box:not([open]) > summary { border-bottom-color: transparent; border-radius: 10px; }
.topo-box > summary::-webkit-details-marker { display: none; }
/* 标题排版统一走全局 .panel-title，这里只保留 scoped 所需的结构样式 */
.tb-title { display: inline-flex; align-items: center; }
.tb-meta { font-size: 12px; color: var(--hint); }
.tb-tools { display: inline-flex; align-items: center; gap: 8px; }
.tb-switch { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.tb-view { font-size: 11px; padding: 2px 9px; border: 0; background: var(--surface); color: var(--muted); cursor: pointer; }
.tb-view + .tb-view { border-left: 1px solid var(--line); }
.tb-view.on { background: var(--accent); color: #fff; }
.tb-refresh { font-size: 11px; padding: 2px 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--muted); cursor: pointer; }
.tb-refresh:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.tb-refresh:disabled { opacity: .6; cursor: default; }
.tb-body { padding: 0 14px 12px; }
/* 图形视图：只留画布，去掉内边距，贴住面板圆角 */
.tb-body-graph { padding: 0; overflow: hidden; border-radius: 0 0 9px 9px; }
.tb-note { font-size: 12px; color: var(--muted); line-height: 1.6; padding: 8px 10px; border-radius: 6px; background: var(--code-bg); border: 1px solid var(--line); margin-bottom: 12px; }
.tb-section { margin-bottom: 14px; }
.tb-head { font-size: 12px; font-weight: 500; color: var(--text); display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.tb-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.tb-dot.read { background: #378ADD; }
.tb-dot.ctx-read { background: #7F77DD; }
.tb-dot.write { background: #D85A30; }
.tb-dot.ctx { background: #1D9E75; }
.tb-count { color: var(--hint); font-weight: 400; }
.tb-items { display: flex; flex-wrap: wrap; gap: 6px; }
.tb-item { font-size: 11px; line-height: 1.5; padding: 3px 8px; border-radius: 5px; background: var(--surface); border: 1px solid var(--line); word-break: break-all; }
/* 实体/上下文条目可 hover 实时取值：给出可交互提示；浮层由公共组件 LiveValueTip 渲染 */
.tb-item[class*="read"], .tb-item.write, .tb-item.ctx { cursor: help; }
.tb-item:hover { border-color: var(--accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent); }
.tb-item.read { color: #378ADD; }
.tb-item.ctx-read { color: #7F77DD; }
.tb-item.write { color: #D85A30; }
.tb-item.ctx { color: #1D9E75; }
.tb-dot.call { background: #D97706; }
.tb-item.call { color: #D97706; }
.tb-dot.dep { background: #0E9F9F; }
.tb-item.dep { color: #0E9F9F; }
.tb-services { margin-top: 6px; font-size: 11px; color: var(--hint); display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.tb-svc { font-size: 11px; color: var(--muted); }
.tb-empty { font-size: 12px; color: var(--hint); padding: 4px 0; }
</style>
