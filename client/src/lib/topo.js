/* 拓扑图公共常量与几何工具：全局图（GlobalTopology）与单脚本图（TopologyGraph）共用，
 * 保证节点分类、连线配色、箭头样式、边界裁剪完全一致。 */
import { MarkerType } from '@vue-flow/core';
import { forceSimulation } from 'd3-force';

export const KIND = {
  script: { color: '#2f6fed', label: '脚本', icon: '⌁' },
  entity: { color: '#378ADD', label: '实体', icon: '●' },
  context: { color: '#7F77DD', label: '上下文', icon: '◇' },
};

export const REL = {
  read: { color: '#378ADD', label: '读实体' },
  write: { color: '#D85A30', label: '写实体' },
  contextRead: { color: '#7F77DD', label: '读上下文' },
  contextWrite: { color: '#1D9E75', label: '写上下文' },
  call: { color: '#b8f70d', label: '调用脚本' },        // ctx.call：A → B（控制流）
  taskDep: { color: '#f0138d', label: '依赖脚本状态' },  // task.status/require/watch：B → A（状态流）
};

/* 碰撞半径（圆形近似，取节点盒半对角线）与定位偏移分开维护：
 * 节点盒宽 120~170、高约 66，碰撞半径必须覆盖半宽，否则节点会横向堆叠。 */
const COLLIDE_R = { script: 105, context: 92, entity: 95 };
const OFFSET_R = { script: 80, context: 68, entity: 62 };
export const collideR = (kind) => COLLIDE_R[kind] || 95;
const offsetR = (kind) => OFFSET_R[kind] || 62;

/* 箭头与连线同色、同尺寸 */
export function arrowMarker(rel) {
  return { type: MarkerType.ArrowClosed, color: REL[rel]?.color || '#888', width: 16, height: 16 };
}

/* 沿源→目标方向，把端点收缩到各自节点矩形边界外侧，保证箭头可见 */
export function edgePath(p) {
  const sx = p.sourceX, sy = p.sourceY, tx = p.targetX, ty = p.targetY;
  const sw = p.sourceNode?.dimensions?.width || 0;
  const sh = p.sourceNode?.dimensions?.height || 0;
  const tw = p.targetNode?.dimensions?.width || 0;
  const th = p.targetNode?.dimensions?.height || 0;
  const dx = tx - sx, dy = ty - sy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const GAP = 10; // 箭头与节点之间留白
  let x1 = sx, y1 = sy, x2 = tx, y2 = ty;
  if (tw && th) {
    const k = Math.min(
      Math.abs(ux) > 1e-6 ? (tw / 2) / Math.abs(ux) : Infinity,
      Math.abs(uy) > 1e-6 ? (th / 2) / Math.abs(uy) : Infinity,
    );
    if (Number.isFinite(k)) { x2 = tx - ux * (k + GAP); y2 = ty - uy * (k + GAP); }
  }
  if (sw && sh) {
    const k = Math.min(
      Math.abs(ux) > 1e-6 ? (sw / 2) / Math.abs(ux) : Infinity,
      Math.abs(uy) > 1e-6 ? (sh / 2) / Math.abs(uy) : Infinity,
    );
    if (Number.isFinite(k)) { x1 = sx + ux * (k + 2); y1 = sy + uy * (k + 2); }
  }
  return `M ${x1} ${y1} L ${x2} ${y2}`;
}

/* ---------- 布局层共用管线（单脚本图 / 全局图同构部分，审计 P2 收敛） ----------
 * 两张图的 buildGraph（单 hub vs 多分量）与力配置不同，不合并；以下只收敛
 * 坐标缓存、拖动固定、边去重、同步收敛与节点上屏这些逐字重复的部分。 */

/* 同步收敛的迭代次数：alpha 每 tick 衰减 2.5%，300 次后已远低于 alphaMin，等价于跑完整个动画 */
export const SETTLE_TICKS = 300;

/* 合并同向重复边（同一脚本读同一实体多次只画一条） */
export function dedupeLinks(links) {
  const seen = new Set();
  return links.filter((l) => {
    const k = `${l.source}|${l.target}|${l.rel}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

/* 拖动固定：把 Vue Flow 拖动后的节点位置换算回 d3 坐标（fx/fy 固定点），
 * 同时写入坐标缓存供下次重建布局沿用。布局已同步收敛静态化，
 * 拖动只更新缓存、不引发全图运动。 */
export function pinSimNode(simNodes, posCache, node) {
  const n = simNodes.find((x) => x.id === node.id);
  if (!n) return;
  n.fx = node.position.x + offsetR(n.kind);
  n.fy = node.position.y + offsetR(n.kind) / 2;
  posCache.set(n.id, { x: n.fx, y: n.fy });
}

/* 同步一次性收敛：configure 里挂好各自的力（link/charge/collide/x/y，连线副本自行复制），
 * 这里统一 stop + tick 到稳态并回写坐标缓存。不做逐帧动画：
 * 打开即最终形态（无微抖动），首帧即定型坐标（fitView 一次到位），任意时刻可拖动。 */
export function settleSync(simNodes, configure, posCache) {
  const sim = configure(forceSimulation(simNodes)).stop();
  sim.tick(SETTLE_TICKS);
  for (const n of simNodes) posCache.set(n.id, { x: n.x, y: n.y });
}

/* d3 坐标 → Vue Flow 展示节点（含节点盒尺寸偏移）。opts.nodeType 为模板插槽名，
 * opts.dataFor(n) 可附加每节点元信息（如全局图的分量 key）。 */
export function toFlowNodes(simNodes, opts = {}) {
  return simNodes.map((n) => ({
    id: n.id,
    type: opts.nodeType || 'topo',
    position: { x: n.x - offsetR(n.kind), y: n.y - offsetR(n.kind) / 2 },
    data: { ...n, ...(opts.dataFor ? opts.dataFor(n) : {}) },
    draggable: true, connectable: false, selectable: false, deletable: false,
  }));
}
