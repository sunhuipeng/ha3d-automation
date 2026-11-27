<script setup>
/* 单脚本运行拓扑图：与全局图同款力导向布局与节点样式（TopoNode / lib/topo 共用）。
 * 脚本节点固定在原点；输入类（读实体/读上下文）被拉向左侧，输出类（写实体/写上下文）拉向右侧，
 * 形成“左进右出”的中心辐射形态。既是输入又是输出的实体归右侧（先读后改的语义）。
 * 箭头按数据流方向（读：实体/上下文 → 脚本；写：脚本 → 实体/上下文），线段裁到节点边界外。
 * 只渲染画布本身，不带图例/说明等额外元素。 */
import { ref, computed, watch, nextTick } from 'vue';
import { VueFlow, BaseEdge, useVueFlow } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import {
  forceLink, forceManyBody, forceCollide, forceX, forceY,
} from 'd3-force';
import TopoNode from './TopoNode.vue';
import LiveValueTip from './LiveValueTip.vue';
import { useLiveTip } from '../lib/live-tip';
import {
  REL, collideR, arrowMarker, edgePath, dedupeLinks, pinSimNode, toFlowNodes, settleSync,
} from '../lib/topo';

const props = defineProps({
  group: { type: Object, default: null },
  entityLabels: { type: Object, default: () => ({}) },
  scriptNames: { type: Object, default: () => ({}) },
  scriptName: { type: String, default: '' },
  scriptId: { type: String, default: '' },
  mode: { type: String, default: 'shadow' },
});

const SCRIPT_NODE = '__script__';
const nodes = ref([]);
const edges = ref([]);
let simNodes = [];
/* 拖动/上次布局的坐标缓存：刷新数据后沿用，避免节点弹回原位 */
const posCache = new Map();
const { fitView } = useVueFlow();

function friendly(id) {
  const s = String(id || '');
  return props.entityLabels?.[s]?.name || s;
}

function buildGraph() {
  const g = props.group || {};
  const defs = new Map();
  defs.set(SCRIPT_NODE, {
    id: SCRIPT_NODE,
    kind: 'script',
    label: props.scriptName || props.scriptId || '脚本',
    sub: props.scriptId,
    side: 'hub',
  });
  const links = [];
  const add = (kind, id, rel, dir) => {
    const nid = `${kind}:${id}`;
    if (!defs.has(nid)) {
      defs.set(nid, kind === 'entity'
        ? { id: nid, kind, label: friendly(id), sub: String(id), side: dir }
        : { id: nid, kind, label: String(id), sub: '上下文', side: dir });
    } else if (dir === 'out') {
      /* 同一实体既读又写时归右侧：先读后改的语义，避免节点两侧摇摆 */
      defs.get(nid).side = 'out';
    }
    links.push(dir === 'in'
      ? { source: nid, target: SCRIPT_NODE, rel }
      : { source: SCRIPT_NODE, target: nid, rel });
  };
  for (const e of g.reads || []) add('entity', e, 'read', 'in');
  for (const e of g.writes || []) add('entity', e, 'write', 'out');
  for (const c of g.contextReads || []) add('context', c, 'contextRead', 'in');
  for (const c of g.contexts || []) add('context', c, 'contextWrite', 'out');
  /* 脚本间关系：远端脚本节点（虚线弱化样式）。左进右出口径——
   * taskDeps（本脚本消费别人状态）在左；calls（本脚本调起别人执行）在右；
   * 同一远端脚本既被调又被依赖时归右（与实体先读后改归右的语义一致） */
  const remoteScript = (sid, dir) => {
    const nid = `script:${sid}`;
    if (!defs.has(nid)) {
      defs.set(nid, {
        id: nid, kind: 'script', remote: true, side: dir,
        label: props.scriptNames?.[sid] || sid, sub: sid,
      });
    } else if (dir === 'out') {
      defs.get(nid).side = 'out';
    }
    links.push(dir === 'in'
      ? { source: nid, target: SCRIPT_NODE, rel: 'taskDep' }
      : { source: SCRIPT_NODE, target: nid, rel: 'call' });
  };
  for (const t of g.calls || []) remoteScript(t, 'out');
  for (const t of g.taskDeps || []) remoteScript(t, 'in');
  /* 同一脚本读同一实体多次只画一条 */
  return { defs, links: dedupeLinks(links) };
}

function rebuild() {
  const { defs, links } = buildGraph();
  if (defs.size <= 1) { nodes.value = []; edges.value = []; return; }
  const simNodeList = [...defs.values()].map((d) => {
    const old = posCache.get(d.id);
    if (old) return { ...d, x: old.x, y: old.y };
    /* 中心脚本从原点起步；其余节点按 side 偏左/偏右起步，加快收敛到目标侧 */
    if (d.kind === 'script' && d.id === SCRIPT_NODE) return { ...d, x: 0, y: 0 };
    const sx = d.side === 'out' ? 380 : -380;
    return { ...d, x: sx + (Math.random() - 0.5) * 160, y: (Math.random() - 0.5) * 260 };
  });
  /* 纵向抖动目标：让同侧节点在竖直方向均匀散开，不挤成一坨 */
  const others = simNodeList.filter((n) => n.kind !== 'script');
  const half = Math.floor(others.length / 2) || 1;
  for (const [i, n] of others.entries()) n.jy = ((i % half) - (half - 1) / 2) * 90 + (Math.random() - 0.5) * 40;
  simNodes = simNodeList;
  /* 脚本固定在原点（或上次拖动的位置）：其余节点被连线牵引着环绕，形成中心辐射形态 */
  const hub = simNodes.find((n) => n.kind === 'script');
  if (hub) { hub.fx = hub.x; hub.fy = hub.y; }
  /* 同步一次性收敛：先算到稳态再上屏，不做逐帧动画。
   * 好处：① 打开即最终形态，无微抖动；② 首帧就是定型坐标，fitView 一次到位，不会先溢出画布再缩回。 */
  settleSync(simNodes, (sim) => sim
    .force('link', forceLink(links.map((l) => ({ ...l }))).id((d) => d.id).distance(180).strength(0.45))
    .force('charge', forceManyBody().strength(-620))
    .force('collide', forceCollide((d) => collideR(d.kind)))
    /* 横向按角色拉：输入类 → 左列，输出类 → 右列，脚本固定原点（fx/fy 优先级更高） */
    .force('x', forceX((d) => (d.kind === 'script' ? 0 : d.side === 'out' ? 300 : -300)).strength(0.09))
    /* 纵向按抖动目标散开，同侧节点均匀分布 */
    .force('y', forceY((d) => (d.kind === 'script' ? 0 : d.jy || 0)).strength(0.05)), posCache);
  publishNodes();
  /* 坐标定型后一次 fitView（duration 0：连镜头动画也不要） */
  nextTick(() => setTimeout(() => fitView({ padding: 0.18, duration: 0 }), 0));
  edges.value = links.map((l) => ({
    id: `te_${l.source}_${l.target}_${l.rel}`,
    source: l.source, target: l.target,
    sourceHandle: 'c', targetHandle: 'c', type: 'straightedge',
    markerEnd: arrowMarker(l.rel),
    style: { stroke: REL[l.rel]?.color || '#888', strokeWidth: 1.8, opacity: 0.9 },
  }));
}

/* 把 simNodes 坐标写回展示节点 */
function publishNodes() {
  nodes.value = toFlowNodes(simNodes);
}

/* 拖动：把新位置写入缓存，下次重建布局时沿用（布局已静态化，拖动不会引起全图再运动） */
function onNodeDrag({ node }) { pinSimNode(simNodes, posCache, node); }
function onNodeDragStop({ node }) { pinSimNode(simNodes, posCache, node); }

/* ---------- hover 实时取值 ----------
 * 实体取 data.sub（entity_id），上下文取 data.label（scope.key），脚本节点无值不请求。
 * 每次 enter 都请求 + hover 期间 3s 轮询；拖动开始即隐藏（避免浮层跟着节点跑）。 */
const { tip, open, move, hide } = useLiveTip({ pollMs: 3000 });
function onNodeEnter({ node, event }) {
  const d = node.data || {};
  if (d.kind !== 'entity' && d.kind !== 'context') return;
  open(event, { kind: d.kind, id: d.kind === 'entity' ? d.sub : d.label, scriptId: props.scriptId, mode: props.mode });
}
function onNodeLeave() { hide(); }
function onNodeMove({ event }) { move(event); }

watch(() => props.group, rebuild, { immediate: true });

const hasData = computed(() => nodes.value.length > 0);
</script>

<template>
  <div class="tg-canvas" :class="{ 'tg-canvas-empty': !hasData }">
    <div v-if="!hasData" class="tg-empty">该通道暂无拓扑观测数据，脚本运行后会逐步出现节点。</div>
    <VueFlow
      v-else
      :nodes="nodes" :edges="edges"
      :nodes-connectable="false" :elements-selectable="false" :nodes-focusable="false"
      :edges-updatable="false" :zoom-on-double-click="false" :zoom-on-scroll="false"
      :pan-on-scroll="false" fit-view-on-init :min-zoom="0.12" :max-zoom="2"
      @node-drag="onNodeDrag" @node-drag-stop="onNodeDragStop" @node-drag-start="hide"
      @node-mouse-enter="onNodeEnter" @node-mouse-leave="onNodeLeave" @node-mouse-move="onNodeMove"
    >
      <template #node-topo="p">
        <TopoNode :data="p.data" />
      </template>
      <template #edge-straightedge="p">
        <BaseEdge :path="edgePath(p)" :marker-end="p.markerEnd" :style="p.style" />
      </template>
      <Background :gap="20" :size="1.4" pattern-color="var(--vf-dot, #d5dae2)" />
    </VueFlow>
    <LiveValueTip :tip="tip" />
  </div>
</template>

<style scoped>
/* 只保留画布：无外框、无图例、无说明；高度为列表视图下视觉高度的两倍，切换到图形时给足展开空间 */
.tg-canvas { height: 800px; background: var(--code-bg); }
.tg-canvas-empty { display: flex; align-items: center; justify-content: center; }
.tg-empty { font-size: 12px; color: var(--hint); text-align: center; }
</style>
