<script setup>
/* 脚本源码只读展示：类 VSCode 的轻量预览（文件标签 + 行号 + 语法着色 + 状态栏）。
 * 明确不提供编辑、保存、复制以外的任何写入入口；详情接口返回的 script 仅作投影。 */
import { computed } from 'vue';
import { useScriptStore } from '../stores/scripts';
import { highlight } from '../lib/highlight';

const store = useScriptStore();
const source = computed(() => store.current?.script || '');
const lines = computed(() => source.value.replace(/\r\n?/g, '\n').split('\n').map((text, i) => ({
  n: i + 1,
  html: highlight(text),
})));

</script>

<template>
  <details class="code-box">
    <summary>
      <span class="cb-title"><span class="panel-chev"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>脚本源码 <span class="cb-file">script.js</span></span>
      <span class="cb-meta">只读 · v{{ store.current?.version || '-' }} · {{ lines.length }} 行</span>
    </summary>
    <div class="vs-editor">
      <div class="vs-tabs">
        <span class="vs-tab active"><i class="vs-js">JS</i> script.js</span>
        <span class="vs-readonly">READ ONLY</span>
      </div>
      <div class="vs-code">
        <div v-for="line in lines" :key="line.n" class="vs-line">
          <span class="vs-ln">{{ line.n }}</span>
          <!-- 源码来自本地版本仓库，已逐字符转义后再着色；只展示，不执行 -->
          <code class="vs-text" v-html="line.html"></code>
        </div>
      </div>
      <div class="vs-status">
        <span>JavaScript</span><span>UTF-8</span><span>只读投影 · 执行真相为 script.js</span>
      </div>
    </div>
  </details>
</template>
