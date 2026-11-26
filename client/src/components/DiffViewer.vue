<script setup>
/* 脚本版本 diff 弹层：服务端 computeDiff 产出并排配对行 + 字符级段，这里只做渲染。
 * 只有 VSCode 风格并排双栏（左正式 / 右影子）；"完整文件"就地切换 sideRows/allSideRows，不二次请求。 */
import { ref, computed, watch } from 'vue';
import { highlight } from '../lib/highlight';

const props = defineProps({ open: Boolean, scriptId: String, from: Number, to: Number });
const emit = defineEmits(['close']);

const data = ref(null);
const loading = ref(false);
const failed = ref(false);
const full = ref(false);

watch(() => props.open, async (v) => {
  if (!v) return;
  loading.value = true; failed.value = false; data.value = null; full.value = false;
  try {
    const q = new URLSearchParams({ from: String(props.from), to: String(props.to) });
    const resp = await fetch(`/api/script/${encodeURIComponent(props.scriptId)}/diff?${q}`);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();
    if (!json.sideRows) throw new Error('unsupported diff payload');
    data.value = json;
  } catch (e) { failed.value = true; }
  finally { loading.value = false; }
});

const sideRows = computed(() => (data.value ? (full.value ? data.value.allSideRows : data.value.sideRows) : []));
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="modal diff-modal">
      <div class="m-head">
        <strong>脚本变更对比</strong>
        <button class="x" title="关闭" @click="emit('close')">×</button>
      </div>
      <div v-if="data" class="diff-meta">
        <span class="diff-side old">正式 v{{ data.from }}</span>
        <span class="diff-arrow">→</span>
        <span class="diff-side new">影子 v{{ data.to }}</span>
        <span class="diff-stat add">+{{ data.added }}</span>
        <span class="diff-stat del">−{{ data.removed }}</span>
        <label class="diff-toggle"><input type="checkbox" v-model="full" /> 完整文件</label>
      </div>
      <div class="diff-body">
        <div v-if="loading" class="diff-empty">正在计算差异…</div>
        <div v-else-if="failed" class="diff-empty err">加载失败：对比版本不存在或服务未响应</div>
        <div v-else-if="data && !data.changed" class="diff-empty">两个版本内容一致，无差异</div>

        <!-- 并排双栏（唯一视图）：一行里左右各占一列，行号独立，共享同一滚动容器天然同步滚动 -->
        <template v-else>
          <div class="side-head">
            <span class="sno">#</span><span class="scol old">正式 v{{ data.from }}</span>
            <span class="sno">#</span><span class="scol new">影子 v{{ data.to }}</span>
          </div>
          <div class="side-rows">
            <template v-for="(row, i) in sideRows" :key="i">
              <div v-if="row.kind === 'gap'" class="side-row gap">
                <span class="sno">…</span><span class="scode">… 省略 {{ row.count }} 行未变更内容 …</span>
                <span class="sno">…</span><span class="scode"></span>
              </div>
              <div v-else class="side-row" :class="row.kind">
                <span class="sno">{{ row.left ? row.left.no : '' }}</span>
                <code class="scode" :class="{ empty: !row.left }">
                  <template v-if="row.inline && row.kind === 'change'"><span v-for="(seg, j) in row.inline.left" :key="j" :class="{ chg: seg.changed }" v-html="highlight(seg.text)"></span></template>
                  <span v-else-if="row.left" v-html="highlight(row.left.text)"></span>
                </code>
                <span class="sno">{{ row.right ? row.right.no : '' }}</span>
                <code class="scode" :class="{ empty: !row.right }">
                  <template v-if="row.inline && row.kind === 'change'"><span v-for="(seg, j) in row.inline.right" :key="j" :class="{ chg: seg.changed }" v-html="highlight(seg.text)"></span></template>
                  <span v-else-if="row.right" v-html="highlight(row.right.text)"></span>
                </code>
              </div>
            </template>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
