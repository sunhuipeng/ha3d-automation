<script setup>
/* 流程预览：用 Vue Flow 渲染 flow.json 的 nodes/edges/layout。
 * 节点可拖动（仅本次查看的临时位置，不回写 flow.json）；连线/删除仍不可编辑 —— 执行真相是脚本。
 * 节点按 type 着色、按运行时 nodeStates 显示状态；亮暗主题由 CSS 变量驱动。 */
import { computed, ref, watch } from 'vue';
import { VueFlow, Handle, MarkerType, Position, BaseEdge } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import dagre from 'dagre';
import { useScriptStore } from '../stores/scripts';

const store = useScriptStore();
const flow = computed(() => store.current?.flow || null);
const nodeStates = computed(() => store.nodeStates || {});

const TYPE_META = {
  trigger:   { label: '触发', color: '#2f6fed', icon: '▶' },
  condition: { label: '条件', color: '#b86d10', icon: '◆' },
  action:    { label: '动作', color: '#0f9d6e', icon: '✦' },
  delay:     { label: '延时', color: '#7f77dd', icon: '◷' },
  announce:  { label: '播报', color: '#c0397b', icon: '♪' },
};

/* flow.json 可省略 layout：缺失时用 dagre 自动布局（分层 + 消交叉 + 对齐，左→右）。
 * 卡片定宽 190px，高度按文案行数估算，保证不重叠。任一节点缺 layout 时整图自动布局。 */
const CARD_W = 190;
const CARD_H_BASE = 62;
const LINE_H = 17; /* 12px * line-height 1.4 */

function estimateHeight(label) {
  const len = String(label || '').length;
  const lines = Math.max(1, Math.ceil(len / 13)); /* 190px 卡内可容纳约 13 个全角字符/行 */
  return CARD_H_BASE + (lines - 1) * LINE_H;
}

function autoLayout(nodes, edges) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 26, ranksep: 64, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    g.setNode(n.id, { width: CARD_W, height: estimateHeight(n.label || n.id) });
  }
  for (const e of edges || []) {
    if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to);
  }
  dagre.layout(g);
  const pos = new Map();
  g.nodes().forEach((id) => {
    const n = g.node(id);
    /* dagre 返回中心点坐标，Vue Flow 需要左上角 */
    pos.set(id, { x: n.x - n.width / 2, y: n.y - n.height / 2 });
  });
  return pos;
}

/* 拖动后的临时坐标：只在本次会话生效，不回写 flow.json。
 * 不记录的话，nodeStates 变化导致 nodes 重算时会把节点弹回自动布局位置。 */
const posOverride = ref(new Map());
const flowKey = computed(() => `${store.current?.id || 'x'}-v${store.current?.version || 0}`);
watch(flowKey, () => { posOverride.value = new Map(); });

/* flow.json → Vue Flow 数据结构 */
const nodes = computed(() => {
  if (!flow.value) return [];
  const list = flow.value.nodes || [];
  const needAuto = list.some((n) => !n.layout || n.layout.x == null || n.layout.y == null);
  const auto = needAuto ? autoLayout(list, flow.value.edges) : null;
  return list.map((n) => {
    const meta = TYPE_META[n.type] || { label: n.type, color: '#888', icon: '•' };
    const state = nodeStates.value[n.id];
    const p = posOverride.value.get(n.id)
      || (needAuto ? auto.get(n.id) : { x: Number(n.layout.x) || 0, y: Number(n.layout.y) || 0 });
    return {
      id: n.id,
      type: 'flow',
      position: p,
      data: { label: n.label || n.id, kind: n.type, kindLabel: meta.label, color: meta.color, icon: meta.icon, state },
      draggable: true,
      connectable: false,
      selectable: false,
      deletable: false,
    };
  });
});

function onNodeDragStop({ node }) {
  const next = new Map(posOverride.value);
  next.set(node.id, { x: node.position.x, y: node.position.y });
  posOverride.value = next;
}

const edges = computed(() => {
  if (!flow.value) return [];
  const list = flow.value.edges || [];
  const posById = new Map(nodes.value.map((n) => [n.id, n.position]));
  /* 错线：同一段列间距内穿行的边，垂直段 x 与出入口 y 按序号错开，避免叠成一束 */
  const groups = new Map();
  list.forEach((e, i) => {
    const a = posById.get(e.from), b = posById.get(e.to);
    const key = a && b ? Math.round(a.x) + '_' + Math.round(b.x) : '_';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ i, a, b });
  });
  const offs = new Map();
  for (const g of groups.values()) {
    g.sort((p, q) => (p.a?.y || 0) - (q.a?.y || 0) || (p.b?.y || 0) - (q.b?.y || 0));
    g.forEach((it, idx) => offs.set(it.i, (idx - (g.length - 1) / 2) * 7));
  }
  return list.map((e, i) => ({
    id: `e_${i}_${e.from}_${e.to}`,
    source: e.from,
    target: e.to,
    sourceHandle: 'out',
    targetHandle: 'in',
    type: 'bus',
    data: { off: offs.get(i) || 0 },
    markerEnd: MarkerType.ArrowClosed,
  }));
});

/* bus 边：圆角正交布线，中缝垂直段按 data.off 错开 */
function roundedPath(pts, r = 8) {
  if (pts.length < 3) return 'M ' + pts.map((p) => p.join(' ')).join(' L ');
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const d1 = Math.hypot(x1 - x0, y1 - y0), d2 = Math.hypot(x2 - x1, y2 - y1);
    if (!d1 || !d2) continue;
    const rr = Math.min(r, d1 / 2, d2 / 2);
    d += ` L ${x1 - ((x1 - x0) / d1) * rr} ${y1 - ((y1 - y0) / d1) * rr} Q ${x1} ${y1} ${x1 + ((x2 - x1) / d2) * rr} ${y1 + ((y2 - y1) / d2) * rr}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last[0]} ${last[1]}`;
  return d;
}

function busPath(props) {
  const off = Number(props.data?.off) || 0;
  const sx = props.sourceX, sy = props.sourceY + off * 0.45;
  const tx = props.targetX, ty = props.targetY;
  if (Math.abs(sy - ty) < 2 && off === 0) return `M ${sx} ${sy} L ${tx} ${ty}`;
  if (tx - sx < 24) return roundedPath([[sx, sy], [tx, ty]]);
  let mx = sx + (tx - sx) / 2 + off;
  mx = Math.min(Math.max(mx, sx + 14), tx - 14);
  return roundedPath([[sx, sy], [mx, sy], [mx, ty], [tx, ty]]);
}
</script>

<template>
  <div class="flow-wrap">
    <div v-if="!flow" class="flow-empty">选择脚本查看流程描述（只读投影）</div>
    <div v-else class="flow-canvas">
      <VueFlow
        :key="flowKey"
        :nodes="nodes"
        :edges="edges"
        :nodes-draggable="true"
        :nodes-connectable="false"
        :elements-selectable="false"
        :nodes-focusable="false"
        :edges-updatable="false"
        :zoom-on-double-click="false"
        :zoom-on-scroll="false"
        :pan-on-scroll="false"
        fit-view-on-init
        :min-zoom="0.4"
        :max-zoom="1.8"
        @node-drag-stop="onNodeDragStop"
      >
        <template #node-flow="props">
          <div class="vf-node" :class="[props.data.kind, props.data.state || '']" :style="{ '--nc': props.data.color }">
            <div class="vf-node-head">
              <span class="vf-ic">{{ props.data.icon }}</span>
              <span class="vf-kind">{{ props.data.kindLabel }}</span>
              <span v-if="props.data.state" class="vf-state" :class="props.data.state"></span>
            </div>
            <div class="vf-label">{{ props.data.label }}</div>
            <Handle type="target" :position="Position.Left" id="in" />
            <Handle type="source" :position="Position.Right" id="out" />
          </div>
        </template>
        <template #edge-bus="props">
          <BaseEdge :path="busPath(props)" :marker-end="props.markerEnd" :style="{ strokeWidth: 1.6 }" />
        </template>
        <Background :gap="20" :size="1.4" pattern-color="var(--vf-dot, #d5dae2)" />
      </VueFlow>
    </div>
    <div class="flow-hint">
      <span class="fh-left">节点可拖动 · 位置仅本次查看生效 · Ctrl+滚轮缩放 · 执行真相为 script.js · 流程描述来自 flow.json v{{ store.current?.version || '-' }}</span>
      <span class="fh-legend">
        <i class="lg trigger"></i>触发
        <i class="lg condition"></i>条件
        <i class="lg delay"></i>延时
        <i class="lg action"></i>动作
        <i class="lg announce"></i>播报
      </span>
    </div>
  </div>
</template>
