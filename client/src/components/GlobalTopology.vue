<script setup>
/* 全局运行拓扑（力导向）：跨脚本展示正式通道的真实观测关系。
 * 节点 = 脚本 / 实体 / 上下文；边 = 读实体、写实体、读上下文、写上下文。
 * 跨脚本关联（A 写上下文 → B 读同一上下文）会在图上自然连成一条可见链路。
 * 布局：d3-force 算坐标，Vue Flow 负责渲染。手动刷新，不轮询；
 * 刷新保留旧坐标，只给新增节点 reheat，避免整图跳变。 */
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { VueFlow, BaseEdge, useVueFlow } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import {
  forceLink, forceManyBody, forceCollide, forceX, forceY,
} from 'd3-force';
import TopoNode from './TopoNode.vue';
import LiveValueTip from './LiveValueTip.vue';
import { useLiveTip } from '../lib/live-tip';
import { useScriptStore } from '../stores/scripts';
import {
  KIND, REL, collideR, arrowMarker, edgePath, dedupeLinks, pinSimNode, toFlowNodes, settleSync,
} from '../lib/topo';

const CANVAS_W = 1500, CANVAS_H = 900;
/* 每个连通分量分配一个网格中心：互不相干的脚本组会各自成图，不被全局向心力揉成一团 */
const COMPONENT_GAP_X = 780, COMPONENT_GAP_Y = 620;

const loading = ref(false);
const error = ref('');
const updatedAt = ref('');
const nodes = ref([]);
const edges = ref([]);
const hovered = ref(null);
const componentCount = ref(0);
const filters = ref({ script: true, entity: true, context: true });
const selectedComp = ref('');      // 子图筛选：'' = 全部，否则为分量稳定 key
const compOptions = ref([]);       // [{ key, label, nodeCount }]

const { fitView } = useVueFlow();

/* 坐标缓存：刷新时复用旧节点坐标，新节点从画布中心附近起步 */
const posCache = new Map();
/* simNodes（d3 计算用对象）与展示 nodes（Vue Flow）分离；布局一次性算完后写回展示 nodes */
let simNodes = [];
let simLinks = [];
let linkDefs = [];   // { source:id, target:id, rel }
let nodeDefs = new Map(); // id -> { kind, label, sub, owners? }
let scriptNameMap = {};   // sid -> 脚本名（buildGraph 刷新；hover 分组展示用）
let componentCenters = new Map(); // nodeId -> {x,y}：所属连通分量的目标中心
let compKeyByNode = new Map();    // nodeId -> 分量稳定 key（成员脚本 id 排序拼接，刷新后保持选中）
let compList = [];                // [{ key, label, nodeCount }] 供子图筛选下拉使用

/* 并查集求连通分量：不相连的节点组各自成图，分别分配中心，避免被全局向心力揉成一团 */
function computeComponentCenters() {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== x) { const nx = parent.get(x); parent.set(x, r); x = nx; }
    return r;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const id of nodeDefs.keys()) find(id);
  for (const l of linkDefs) union(l.source, l.target);
  const groups = new Map();
  for (const id of nodeDefs.keys()) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(id);
  }
  /* 大的分量优先放在靠前位置；网格排布，列数取 sqrt 向上取整 */
  const comps = [...groups.values()].sort((a, b) => b.length - a.length);
  const cols = Math.max(1, Math.ceil(Math.sqrt(comps.length)));
  componentCenters = new Map();
  comps.forEach((members, i) => {
    const cx = 280 + (i % cols) * COMPONENT_GAP_X;
    const cy = 240 + Math.floor(i / cols) * COMPONENT_GAP_Y;
    for (const id of members) componentCenters.set(id, { x: cx, y: cy });
  });
  /* 分量元信息：稳定 key（脚本 id 排序拼接）+ 展示标签（取分量内连线最多的脚本名） */
  const degree = new Map();
  for (const l of linkDefs) {
    degree.set(l.source, (degree.get(l.source) || 0) + 1);
    degree.set(l.target, (degree.get(l.target) || 0) + 1);
  }
  compKeyByNode = new Map();
  compList = comps.map((members) => {
    const scriptIds = members.filter((id) => id.startsWith('script:')).map((id) => id.slice('script:'.length)).sort();
    const key = scriptIds.length ? scriptIds.join(',') : [...members].sort().join(',');
    let label = '独立节点';
    let bestDeg = -1;
    for (const id of members) {
      compKeyByNode.set(id, key);
      const d = nodeDefs.get(id);
      if (d?.kind === 'script' && (degree.get(id) || 0) > bestDeg) { bestDeg = degree.get(id) || 0; label = d.label; }
    }
    return { key, label, nodeCount: members.length };
  });
  return comps.length;
}

function friendly(id, entityLabels) {
  const s = String(id || '');
  return entityLabels?.[s]?.name || s;
}

function nodeId(kind, id) { return `${kind}:${id}`; }

function buildGraph(json) {
  const defs = new Map();
  const links = [];
  const labelMap = json.entityLabels || {};
  const scriptNames = json.scriptNames || {};
  const scriptLabel = (sid) => scriptNames[sid] || sid;
  /* 远端脚本节点：被 ctx.call / task 依赖的目标脚本（同远端样式 remote，虚线弱化） */
  const scriptNode = (sid) => {
    const id = nodeId('script', sid);
    if (!defs.has(id)) defs.set(id, { id, kind: 'script', label: scriptLabel(sid), sub: sid, remote: true });
    return id;
  };
  for (const [sid, g] of Object.entries(json.scripts || {})) {
    const sId = nodeId('script', sid);
    defs.set(sId, { id: sId, kind: 'script', label: g.name || sid, sub: sid, status: g.running ? 'running' : 'stopped' });
    for (const e of g.reads || []) {
      const id = nodeId('entity', e);
      if (!defs.has(id)) defs.set(id, { id, kind: 'entity', label: friendly(e, labelMap), sub: String(e) });
      links.push({ source: id, target: sId, rel: 'read' });
    }
    for (const e of g.writes || []) {
      const id = nodeId('entity', e);
      if (!defs.has(id)) defs.set(id, { id, kind: 'entity', label: friendly(e, labelMap), sub: String(e) });
      links.push({ source: sId, target: id, rel: 'write' });
    }
    /* 上下文节点补 owners（方案 A）：local 上下文的值存在 scriptId:mode 命名空间下，
     * 全局图节点不区分脚本，hover 取值时需要知道查哪个脚本的桶；global 虽与脚本无关，也一并记录。
     * 同一 key 被多个脚本读/写时 owners 累积，hover 分组展示各脚本的值。 */
    const ctxNode = (c, sid) => {
      const id = nodeId('context', c);
      const ex = defs.get(id);
      if (!ex) defs.set(id, { id, kind: 'context', label: String(c), sub: '上下文', owners: [sid] });
      else if (!ex.owners.includes(sid)) ex.owners.push(sid);
      return id;
    };
    for (const c of g.contextReads || []) links.push({ source: ctxNode(c, sid), target: sId, rel: 'contextRead' });
    for (const c of g.contexts || []) links.push({ source: sId, target: ctxNode(c, sid), rel: 'contextWrite' });
    /* 脚本间显式关系：call=控制流 A→B（调起执行）；taskDep=状态流 B→A（B 的状态被 A 消费）。
     * 方向沿用全图"数据流"口径，同一对脚本可同时有双向两条边（颜色不同可区分） */
    for (const t of g.calls || []) {
      if (t === sid) continue;
      links.push({ source: sId, target: scriptNode(t), rel: 'call' });
    }
    for (const t of g.taskDeps || []) {
      if (t === sid) continue;
      links.push({ source: scriptNode(t), target: sId, rel: 'taskDep' });
    }
  }
  /* 去掉孤立脚本？保留——脚本本身是图的主角，即使暂无观测也显示 */
  nodeDefs = defs;
  linkDefs = dedupeLinks(links);
  scriptNameMap = scriptNames; // hover 取值分组时展示脚本名
}

function runSimulation(first) {
  const defs = [...nodeDefs.values()];
  simNodes = defs.map((d) => {
    const old = posCache.get(d.id);
    const c = componentCenters.get(d.id) || { x: CANVAS_W / 2, y: CANVAS_H / 2 };
    return {
      ...d,
      /* 已有坐标沿用；新节点从自己分量中心附近起步，避免初次布局时跨图乱飞 */
      x: old ? old.x : c.x + (Math.random() - 0.5) * 120,
      y: old ? old.y : c.y + (Math.random() - 0.5) * 90,
    };
  });
  simLinks = linkDefs.map((l) => ({ ...l }));
  /* 同步一次性收敛：算到稳态后直接上屏，不做逐帧动画（无抖动、首帧即定型，可立即拖动） */
  settleSync(simNodes, (sim) => sim
    .force('link', forceLink(simLinks).id((d) => d.id).distance((l) => (l.rel.startsWith('context') ? 200 : 170)).strength(0.3))
    .force('charge', forceManyBody().strength(-700))
    .force('collide', forceCollide((d) => collideR(d.kind)))
    /* 向心力指向各节点所属分量的中心（不是全图中心），这样互不相连的子图各自聚拢成独立的一张图；
     * strength 调弱让分量内部铺得更开 */
    .force('x', forceX((d) => (componentCenters.get(d.id) || { x: CANVAS_W / 2 }).x).strength(0.045))
    .force('y', forceY((d) => (componentCenters.get(d.id) || { y: CANVAS_H / 2 }).y).strength(0.045)), posCache);
  publishNodes();
  /* 首次布局定型后一次 fitView（duration 0）；后续结构变化不抢镜头，避免打断用户当前的缩放/平移 */
  if (first) nextTick(() => setTimeout(() => fitView({ padding: 0.18, duration: 0 }), 0));
}

/* 把 simNodes 坐标（含分量归属）写回展示节点 */
function publishNodes() {
  nodes.value = toFlowNodes(simNodes, {
    nodeType: 'gt',
    dataFor: (n) => ({ compKey: compKeyByNode.get(n.id) || '' }),
  });
}

function renderEdges() {
  edges.value = linkDefs.map((l, i) => {
    const dim = hovered.value && l.source !== hovered.value && l.target !== hovered.value;
    const color = REL[l.rel]?.color || '#888';
    return {
      id: `ge_${i}_${l.source}_${l.target}_${l.rel}`,
      source: l.source, target: l.target,
      sourceHandle: 'c', targetHandle: 'c',
      type: 'straightedge',
      /* 箭头与连线同色、同尺寸：source→target 即数据流方向（读=实体/上下文流向脚本，写=脚本流向实体/上下文） */
      markerEnd: arrowMarker(l.rel),
      style: { stroke: color, strokeWidth: dim ? 0.9 : 1.8, opacity: dim ? 0.18 : 0.9 },
    };
  });
}

/* 过滤：Vue Flow 的 hidden 由节点自身携带；边在目标/源隐藏时自动不显示。
 * 类型过滤（脚本/实体/上下文）与子图筛选叠加生效。 */
const shownNodes = computed(() => nodes.value.map((n) => ({
  ...n,
  hidden: !filters.value[n.data.kind] || (!!selectedComp.value && n.data.compKey !== selectedComp.value),
})));

async function load() {
  /* load 进行中来新的刷新请求：不静默丢弃，标记后在本次完成后尾随补跑一次
   * （否则去抖窗口恰好落在加载期间的状态变化会被永久漏掉）。 */
  if (loading.value) { reloadQueued = true; return; }
  loading.value = true; error.value = '';
  try {
    const res = await fetch('/api/topology/all');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    updatedAt.value = json.updatedAt || '';
    const prevKeys = new Set(nodeDefs.keys());
    const prevCenters = new Map(componentCenters);
    buildGraph(json);
    const components = computeComponentCenters();
    /* 结构（节点/边/连通分量中心）没变就不重跑模拟，保留现有坐标，零跳变 */
    const nextKeys = new Set(nodeDefs.keys());
    const structureChanged = nodeDefs.size !== prevKeys.size || [...nextKeys].some((k) => !prevKeys.has(k))
      || linkDefs.length !== edges.value.length
      || [...nextKeys].some((k) => prevCenters.has(k)
        && (prevCenters.get(k).x !== componentCenters.get(k).x || prevCenters.get(k).y !== componentCenters.get(k).y));
    componentCount.value = components;
    compOptions.value = compList;
    /* 选中分量已消失（脚本变化）时自动回到全部，避免整图被隐藏 */
    if (selectedComp.value && !compList.some((c) => c.key === selectedComp.value)) selectedComp.value = '';
    if (structureChanged || !nodes.value.length) runSimulation(!nodes.value.length);
    else publishNodes(); // 结构没变也要刷一遍节点，让 compKey 等元信息同步到展示数据
    renderEdges();
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
    if (reloadQueued) { reloadQueued = false; load(); }
  }
}

/* 拖动：写入坐标缓存，下次重建布局时沿用（布局已静态化，拖动不触发全图运动） */
function onNodeDrag({ node }) { pinSimNode(simNodes, posCache, node); }
function onNodeDragStop({ node }) { pinSimNode(simNodes, posCache, node); }

/* 切换子图筛选后，把可见节点居中放大（不重跑模拟，坐标零跳变） */
watch(selectedComp, async () => {
  await nextTick();
  fitView({ padding: 0.15, duration: 300 });
});

/* ---------- hover：连线高亮（原有）+ 实时取值浮层（方案 A）----------
 * 实体取 data.sub（entity_id）；上下文取 data.label（scope.key）：
 * global 单请求读正式桶；local 按 owners 分组并行查各脚本的命名空间（多脚本同 key 时分组展示）。
 * hover 期间 3s 轮询；拖动开始即隐藏，避免浮层跟着节点跑。 */
const { tip, open, move, hide } = useLiveTip({ pollMs: 3000 });
function onNodeEnter({ node, event }) {
  hovered.value = node.id;
  renderEdges();
  const d = node.data || {};
  if (d.kind === 'entity') open(event, { kind: 'entity', id: d.sub });
  else if (d.kind === 'context') {
    open(event, { kind: 'context', id: d.label, scriptIds: d.owners?.length ? d.owners : [''], groupLabels: scriptNameMap });
  }
}
function onNodeLeave() { hovered.value = null; renderEdges(); hide(); }
function onNodeMove({ event }) { move(event); }

onMounted(load);
/* 事件联动刷新（不加定时轮询）：左侧列表由 WS 广播驱动，启动/停止/发布/删除脚本时
 * list 会变化（status、runningVersions、增删行），据此去抖触发一次 load，全局图自动跟进。 */
const scriptStore = useScriptStore();
const listSignature = computed(() => scriptStore.list
  .map((s) => `${s.id}:${s.status}:${(s.runningVersions || []).map((x) => x.version).join('.')}`).join('|'));
let reloadTimer = null;
let reloadQueued = false; // load 进行中收到刷新请求 → 尾随补跑标记
watch(listSignature, () => {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { reloadTimer = null; load(); }, 800);
});
onBeforeUnmount(() => {
  if (reloadTimer) clearTimeout(reloadTimer);
});

function fmtTime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString();
}
</script>

<template>
  <div class="gt-box">
    <div class="gt-head">
      <div class="gt-title">
        <strong>全局运行拓扑</strong>
        <span class="gt-sub">所有脚本 · 仅正式通道 · {{ componentCount }} 个独立子图 · 运行时真实观测</span>
      </div>
      <div class="gt-actions">
        <span class="gt-time">{{ updatedAt ? `更新于 ${fmtTime(updatedAt)}` : '' }}</span>
        <button class="gt-btn" :disabled="loading" @click="load">{{ loading ? '加载中…' : '↻ 手动刷新' }}</button>
      </div>
    </div>

    <div class="gt-note">
      节点代表脚本、实体与上下文；<b>箭头方向表示数据流</b>（读：实体/上下文 → 脚本，写：脚本 → 实体/上下文）。互不相连的脚本组各自成图；跨脚本依赖会经由共享实体/上下文连成一条链路（如 A 写上下文 → B 读同一上下文）。hover 节点可高亮相邻关系，节点可拖动固定。
    </div>

    <div class="gt-toolbar">
      <span class="gt-tb-label">显示：</span>
      <label v-for="(meta, k) in KIND" :key="k" class="gt-filter">
        <input type="checkbox" v-model="filters[k]" /> <i :style="{ background: meta.color }"></i>{{ meta.label }}
      </label>
      <span class="gt-legend-sep"></span>
      <span v-for="(meta, k) in REL" :key="k" class="gt-rel"><i :style="{ background: meta.color }"></i>{{ meta.label }}</span>
      <span class="gt-legend-sep"></span>
      <span class="gt-tb-label">子图：</span>
      <select v-model="selectedComp" class="gt-comp-select" title="只显示某个独立子图（连通分量）">
        <option value="">全部（{{ compOptions.length }}）</option>
        <option v-for="c in compOptions" :key="c.key" :value="c.key">{{ c.label }}（{{ c.nodeCount }}）</option>
      </select>
    </div>

    <div v-if="error" class="gt-error">加载失败：{{ error }}</div>
    <div v-else-if="loading && !nodes.length" class="gt-empty">加载中…</div>
    <div v-else-if="!nodes.length" class="gt-empty">暂无正式通道的拓扑观测数据。脚本运行后会逐步累积。</div>
    <div v-else class="gt-canvas">
      <VueFlow
        :nodes="shownNodes" :edges="edges"
        :nodes-connectable="false" :elements-selectable="false" :nodes-focusable="false"
        :edges-updatable="false" :zoom-on-double-click="false" :zoom-on-scroll="true"
        :pan-on-scroll="false" fit-view-on-init :min-zoom="0.12" :max-zoom="2"
        @node-drag="onNodeDrag" @node-drag-stop="onNodeDragStop" @node-drag-start="hide"
        @node-mouse-enter="onNodeEnter" @node-mouse-leave="onNodeLeave" @node-mouse-move="onNodeMove"
      >
        <template #node-gt="p">
          <TopoNode :data="p.data" />
        </template>
        <template #edge-straightedge="p">
          <BaseEdge :path="edgePath(p)" :marker-end="p.markerEnd" :style="p.style" />
        </template>
        <Background :gap="20" :size="1.4" pattern-color="var(--vf-dot, #d5dae2)" />
      </VueFlow>
      <LiveValueTip :tip="tip" />
    </div>
  </div>
</template>

<style scoped>
.gt-box { border: 1px solid var(--line); border-radius: 10px; margin: 0; background: var(--surface2); overflow: hidden; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.gt-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; background: var(--surface); border-bottom: 1px solid var(--line); flex-shrink: 0; }
.gt-title strong { font-size: 15px; color: var(--text); }
.gt-sub { margin-left: 10px; font-size: 12px; color: var(--hint); }
.gt-actions { display: inline-flex; align-items: center; gap: 10px; }
.gt-time { font-size: 11px; color: var(--hint); }
.gt-btn { font-size: 12px; padding: 5px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--text); cursor: pointer; }
.gt-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.gt-btn:disabled { opacity: .6; cursor: default; }
.gt-note { margin: 10px 16px 0; padding: 7px 10px; font-size: 12px; line-height: 1.6; color: var(--muted); background: var(--code-bg); border: 1px solid var(--line); border-radius: 6px; flex-shrink: 0; }
.gt-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 8px 16px; font-size: 11px; color: var(--muted); flex-shrink: 0; }
.gt-tb-label { color: var(--hint); }
.gt-filter { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.gt-filter i, .gt-rel i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.gt-legend-sep { width: 1px; height: 14px; background: var(--line); }
.gt-rel { display: inline-flex; align-items: center; gap: 4px; }
.gt-comp-select { font-size: 12px; padding: 3px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--text); max-width: 260px; }
/* 画布撑满剩余高度：.gt-box 是满高 flex 列，画布自动吃掉视口减去头/说明/工具条后的全部空间 */
.gt-canvas { flex: 1; min-height: 320px; background: var(--code-bg); border-top: 1px solid var(--line); }
.gt-empty, .gt-error { padding: 48px 16px; text-align: center; font-size: 13px; color: var(--hint); }
.gt-error { color: var(--red); }
</style>
