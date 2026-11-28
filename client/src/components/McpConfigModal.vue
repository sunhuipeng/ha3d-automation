<script setup>
/* MCP 接入配置弹层：配置由服务端 /api/mcp-config 按当前访问地址生成，
 * 前端只展示 + 复制，不自己拼 URL（与 studio 一致）。粘到 WorkBuddy 直接生效。 */
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { copyText } from '../lib/clipboard';

const props = defineProps({ open: Boolean });
const emit = defineEmits(['close']);

const info = ref(null);
const loading = ref(false);
const failed = ref(false);
const copied = ref(false);
const dlBusy = ref(false);
const dlErr = ref('');
let timer = 0;

const text = computed(() => (info.value ? JSON.stringify(info.value.config, null, 2) : ''));

watch(() => props.open, async (v) => {
  if (!v) return;
  copied.value = false; failed.value = false; loading.value = true; info.value = null;
  dlBusy.value = false; dlErr.value = '';
  clearTimeout(timer);
  try {
    const q = import.meta.env.DEV ? '?dev=1' : '';
    const d = await fetch('/api/mcp-config' + q).then((x) => x.json());
    if (!d || !d.ok || !d.config) throw new Error('bad payload');
    info.value = d;
  } catch (e) { failed.value = true; }
  finally { loading.value = false; }
});

async function copy() {
  if (!info.value) return;
  const ok = await copyText(text.value);
  if (!ok) { window.alert('复制失败，请手动选中配置文本复制'); return; }
  copied.value = true;
  clearTimeout(timer);
  timer = setTimeout(() => { copied.value = false; }, 1600);
}

/* 下载 skill 压缩包：Docker 镜像内置 /app/skill.zip；开发环境接口返回失败提示 */
async function downloadSkill() {
  if (dlBusy.value) return;
  dlBusy.value = true; dlErr.value = '';
  try {
    const resp = await fetch('/api/skill-package');
    if (!resp.ok) {
      let msg = 'skill 压缩包不可用（HTTP ' + resp.status + '）';
      try { const d = await resp.json(); if (d && d.error) msg = d.error; } catch (e) {}
      throw new Error(msg);
    }
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ha3d-automation-skill.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  } catch (e) {
    dlErr.value = e.message || '下载失败';
  } finally {
    dlBusy.value = false;
  }
}
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="modal">
      <div class="m-head">
        <h2>MCP 接入配置</h2>
        <button class="x" @click="emit('close')" aria-label="关闭">×</button>
      </div>
      <div class="m-body">
        <p class="tip">复制下面 JSON，粘贴到 WorkBuddy 的 MCP 配置里即可直接连接本项目。skill 压缩包供 Agent 安装本项目技能使用。</p>
        <div v-if="loading" class="empty">正在生成配置…</div>
        <div v-else-if="failed" class="err">配置生成失败，请确认服务已启动。</div>
        <template v-else>
          <div class="dl-row">
            <button class="dl-link" :disabled="dlBusy" @click="downloadSkill">下载 skill 压缩包</button>
            <span class="dl-sep">·</span>
            <a class="dl-link" href="/skill-flow.html" target="_blank" title="skill/SKILL.md 开发流程的可视化速览（静态页，新标签打开）">开发流程可视化</a>
            <span v-if="dlBusy" class="dl-hint">正在下载…</span>
          </div>
          <div v-if="dlErr" class="err">{{ dlErr }}</div>
          <pre class="code">{{ text }}</pre>
        </template>
      </div>
      <div class="m-foot">
        <button @click="emit('close')">关闭</button>
        <button class="primary" :disabled="!info" @click="copy">{{ copied ? '✓ 已复制' : '复制配置' }}</button>
      </div>
    </div>
  </div>
</template>
