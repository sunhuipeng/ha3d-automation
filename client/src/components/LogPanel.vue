<script setup>
/* 运行日志面板（审计 3.2 从 App.vue 抽出）：滚动跟随 / 历史分页 / 跟随状态，
 * 只依赖 script store，App.vue 里不再保留这块滚动补偿逻辑 */
import { ref, watch, nextTick } from 'vue';
import { useScriptStore } from '../stores/scripts';

const scripts = useScriptStore();
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
</script>

<template>
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
