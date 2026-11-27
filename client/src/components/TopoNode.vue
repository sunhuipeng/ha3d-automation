<script setup>
/* 拓扑节点：全局图与单脚本图共用，保证外观完全一致（脚本实心蓝、实体浅蓝实线、上下文浅紫虚线） */
import { Handle, Position } from '@vue-flow/core';
import { KIND } from '../lib/topo';

defineProps({
  data: { type: Object, required: true },
});
</script>

<template>
  <div class="gt-node" :class="[data.kind, { stopped: data.status === 'stopped', remote: !!data.remote }]" :style="{ '--nc': KIND[data.kind]?.color || '#888' }">
    <div class="gt-node-head"><span class="gt-ic">{{ KIND[data.kind]?.icon }}</span>{{ KIND[data.kind]?.label }}<span v-if="data.status === 'stopped'" class="gt-stopped-tag">已停止</span></div>
    <div class="gt-node-label">{{ data.label }}</div>
    <div v-if="data.sub && data.sub !== data.label" class="gt-node-sub">{{ data.sub }}</div>
    <Handle type="target" :position="Position.Top" id="c" class="gt-handle" />
    <Handle type="source" :position="Position.Top" id="c" class="gt-handle" />
  </div>
</template>

<style scoped>
.gt-node { box-sizing: border-box; min-width: 120px; max-width: 170px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--nc); border-left-width: 3px; background: color-mix(in srgb, var(--nc) 8%, var(--surface)); box-shadow: 0 2px 8px rgba(0,0,0,.1); text-align: center; }
/* 三类节点用填充色 + 边框样式区分：脚本=实心蓝、实体=浅蓝填充实线、上下文=浅紫填充虚线 */
.gt-node.script { background: linear-gradient(180deg, #3f80f6, #2f6fed); border: 2px solid #2a62d4; box-shadow: 0 4px 14px rgba(47, 111, 237, .35); }
.gt-node.script .gt-node-head, .gt-node.script .gt-node-label, .gt-node.script .gt-node-sub { color: #fff; }
.gt-node.script .gt-node-sub { opacity: .78; }
/* 远端脚本（ctx.call / task 依赖的目标）：虚线弱化，与当前查看的中心脚本区分开 */
.gt-node.script.remote { background: color-mix(in srgb, #3f80f6 72%, var(--surface)); border: 2px dashed #6ea1f8; box-shadow: 0 2px 8px rgba(47, 111, 237, .18); }
.gt-node.entity { background: color-mix(in srgb, #378ADD 13%, var(--surface)); border: 1px solid #378ADD; }
.gt-node.context { background: color-mix(in srgb, #7F77DD 15%, var(--surface)); border: 1.5px dashed #7F77DD; }
/* 已停止的脚本：整体去色淡化，保留位置便于对比；观测数据仍展示（发生过就是发生过） */
.gt-node.stopped { filter: grayscale(.75); opacity: .55; }
.gt-stopped-tag { margin-left: 4px; font-size: 9px; font-weight: 400; padding: 0 4px; border-radius: 6px; background: rgba(0,0,0,.18); }
.gt-node-head { font-size: 10px; color: var(--nc); display: flex; align-items: center; justify-content: center; gap: 3px; font-weight: 600; }
.gt-ic { font-size: 12px; }
.gt-node-label { font-size: 12px; line-height: 1.35; color: var(--text); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-node.script .gt-node-label { font-weight: 600; font-size: 13px; }
.gt-node-sub { font-size: 10px; color: var(--hint); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-handle { width: 1px !important; height: 1px !important; min-width: 1px !important; min-height: 1px !important; opacity: 0; border: 0 !important; background: transparent !important; left: 50% !important; top: 50% !important; transform: translate(-50%, -50%) !important; }
</style>
