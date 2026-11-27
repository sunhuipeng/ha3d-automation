<script setup>
/* hover 实时取值浮层（纯展示）：由 lib/live-tip.js 的 useLiveTip 驱动，
 * 拓扑列表 / 单脚本图 / 全局图三处共用同一外观与交互。 */
defineProps({ tip: { type: Object, required: true } });
</script>

<template>
  <div v-if="tip.show" class="lv-tip" :style="tip.style">
    <div class="lv-title">{{ tip.title }}</div>
    <div v-if="tip.loading" class="lv-dim">读取中…</div>
    <template v-else>
      <div v-for="(g, gi) in tip.groups" :key="gi" class="lv-group" :class="{ 'lv-multi': tip.groups.length > 1 }">
        <div v-if="g.label" class="lv-group-label">{{ g.label }}</div>
        <div v-for="r in g.rows" :key="r.k" class="lv-row"><span class="k">{{ r.k }}</span><span class="v">{{ r.v }}</span></div>
        <div v-if="g.note" class="lv-note">{{ g.note }}</div>
      </div>
      <div v-if="tip.note" class="lv-note lv-err">{{ tip.note }}</div>
    </template>
  </div>
</template>

<style scoped>
.lv-tip { position: fixed; z-index: 90; min-width: 150px; max-width: 340px; padding: 8px 10px; border-radius: 8px; background: var(--surface); border: 1px solid var(--line); box-shadow: 0 10px 28px rgba(0, 0, 0, .22); pointer-events: none; font-size: 12px; color: var(--text); }
.lv-title { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--muted); margin-bottom: 5px; word-break: break-all; }
.lv-group + .lv-group { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--line); }
.lv-group-label { font-size: 11px; color: var(--accent); margin-bottom: 2px; }
.lv-row { display: flex; gap: 8px; line-height: 1.65; }
.lv-row .k { flex: none; color: var(--hint); }
.lv-row .v { color: var(--text); word-break: break-all; }
.lv-note { margin-top: 4px; font-size: 11px; color: var(--hint); }
.lv-err { color: var(--err-fg); }
.lv-dim { color: var(--hint); }
</style>
