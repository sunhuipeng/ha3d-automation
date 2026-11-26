<script setup>
/* 自定义确认弹窗：替代浏览器原生 confirm，样式复用全局 .overlay/.modal/.m-*。
 * 通过 open/title/message 控制展示，confirm/cancel 事件回传用户选择。 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps({
  open: Boolean,
  title: { type: String, default: '请确认' },
  message: { type: String, default: '' },
  confirmText: { type: String, default: '确定' },
  cancelText: { type: String, default: '取消' },
  danger: Boolean,
  busy: Boolean,
});
const emit = defineEmits(['confirm', 'cancel']);
const cancelBtn = ref(null);

function onKey(e) {
  if (e.key === 'Escape' && props.open && !props.busy) emit('cancel');
}
watch(() => props.open, (v) => {
  if (v) {
    window.addEventListener('keydown', onKey);
    nextTick(() => cancelBtn.value?.focus()); // 安全默认：焦点落在取消
  } else {
    window.removeEventListener('keydown', onKey);
  }
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

function confirm() { if (!props.busy) emit('confirm'); }
function cancel() { if (!props.busy) emit('cancel'); }
</script>

<template>
  <div v-if="open" class="overlay confirm-overlay" @click.self="cancel">
    <div class="modal confirm-modal" role="alertdialog" aria-modal="true" :aria-label="title">
      <div class="m-head"><h2>{{ title }}</h2></div>
      <div class="m-body">
        <div class="confirm-icon" :class="{ 'is-danger': danger }" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <div class="confirm-msg">{{ message }}</div>
      </div>
      <div class="m-foot">
        <button ref="cancelBtn" :disabled="busy" @click="cancel">{{ cancelText }}</button>
        <button :class="danger ? 'danger' : 'primary'" :disabled="busy" @click="confirm">
          {{ busy ? '处理中…' : confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.confirm-modal { width: 420px; }
.m-body { display: flex; flex-direction: column; }
.confirm-icon { width: 24px; height: 24px; flex-shrink: 0; align-self: flex-start; color: var(--amber); margin-bottom: 10px; }
.confirm-icon.is-danger { color: var(--red); }
.confirm-msg { white-space: pre-line; line-height: 1.7; font-size: 13px; color: var(--text); }
.m-foot .danger { background: var(--red); border-color: var(--red); color: #fff; }
</style>
