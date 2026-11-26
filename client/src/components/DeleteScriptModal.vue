<script setup>
/* 删除脚本确认弹层：自定义弹窗替代系统 confirm，必须手动输入脚本 id 才能确认删除。
 * 删除动作由本组件直接调 DELETE /api/script/<id>（服务端同样拒绝运行中脚本），
 * 成功后 emit('deleted', id) 交由父组件刷新列表与清理右侧详情。 */
import { ref, computed, watch } from 'vue';

const props = defineProps({ open: Boolean, script: Object });
const emit = defineEmits(['close', 'deleted']);

const input = ref('');
const busy = ref(false);
const err = ref('');

const canConfirm = computed(() => !!props.script && input.value.trim() === props.script.id);

watch(() => props.open, (v) => { if (v) { input.value = ''; err.value = ''; } });

async function doDelete() {
  if (!canConfirm.value || busy.value) return;
  busy.value = true; err.value = '';
  try {
    const r = await fetch(`/api/script/${props.script.id}`, { method: 'DELETE' }).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    emit('deleted', props.script.id);
    emit('close');
  } catch (e) {
    err.value = e && e.message ? e.message : '删除失败';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="open && script" class="overlay" @click.self="emit('close')">
    <div class="modal">
      <div class="m-head">
        <h2>删除脚本</h2>
        <button class="x" @click="emit('close')" aria-label="关闭">×</button>
      </div>
      <div class="m-body">
        <p class="del-warn">
          将删除脚本「{{ script.name }}」的<strong>全部版本</strong>（含正式版与影子版）及运行日志，删除后不可恢复。
        </p>
        <label>请输入脚本 id <code>{{ script.id }}</code> 以确认删除</label>
        <input v-model="input" class="field mono" placeholder="输入 id 后才可删除" spellcheck="false" @keyup.enter="doDelete" />
        <div v-if="err" class="err">{{ err }}</div>
      </div>
      <div class="m-foot">
        <button @click="emit('close')">取消</button>
        <button class="danger" :disabled="!canConfirm || busy" @click="doDelete">{{ busy ? '删除中…' : '确认删除' }}</button>
      </div>
    </div>
  </div>
</template>
