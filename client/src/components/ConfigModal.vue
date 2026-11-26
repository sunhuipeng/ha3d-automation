<script setup>
/* HA 连接配置弹层：token 只写不读（后端只回传 hasToken），保存后后端自动重连 HA。 */
import { ref, watch } from 'vue';

const props = defineProps({ open: Boolean });
const emit = defineEmits(['close']);

const form = ref({ haUrl: '', token: '', runnerTimeoutMs: 60000, actionCooldownMs: 300, maxRestarts: 3, allowMcpCallService: false });
const hasToken = ref(false);
const saving = ref(false);
const err = ref('');
const ok = ref('');

watch(() => props.open, async (v) => {
  if (!v) return;
  err.value = ''; ok.value = '';
  try {
    const r = await fetch('/api/config').then((x) => x.json());
    form.value = {
      haUrl: r.haUrl || '',
      token: '',
      runnerTimeoutMs: r.runnerTimeoutMs,
      actionCooldownMs: r.actionCooldownMs,
      maxRestarts: r.maxRestarts,
      allowMcpCallService: !!r.allowMcpCallService,
    };
    hasToken.value = !!r.hasToken;
  } catch (e) { err.value = e.message; }
});

async function save() {
  saving.value = true; err.value = ''; ok.value = '';
  try {
    const body = { ...form.value };
    if (!body.token) delete body.token;
    const r = await fetch('/api/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    hasToken.value = !!r.config.hasToken;
    form.value.token = '';
    ok.value = '已保存，HA 正在重连…';
  } catch (e) { err.value = e.message; }
  finally { saving.value = false; }
}
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="modal">
      <div class="m-head">
        <h2>HA 连接配置</h2>
        <button class="x" @click="emit('close')" aria-label="关闭">×</button>
      </div>
      <div class="m-body">
        <label>HA 地址</label>
        <input v-model="form.haUrl" class="field" placeholder="http://192.168.31.16:8123" spellcheck="false" />

        <label>访问 Token <small v-if="hasToken">（已配置，留空保持不变）</small></label>
        <input v-model="form.token" class="field" type="password" placeholder="留空 = 不修改" autocomplete="off" spellcheck="false" />

        <div class="grid">
          <div>
            <label>运行超时 (ms)</label>
            <input v-model.number="form.runnerTimeoutMs" class="field" type="number" min="1000" />
          </div>
          <div>
            <label>动作冷却 (ms)</label>
            <input v-model.number="form.actionCooldownMs" class="field" type="number" min="0" />
          </div>
          <div>
            <label>重启上限</label>
            <input v-model.number="form.maxRestarts" class="field" type="number" min="0" />
          </div>
        </div>

        <label class="check-line">
          <input v-model="form.allowMcpCallService" type="checkbox" />
          允许 MCP 直接调用 HA 服务（automation_call_service，默认关闭）
        </label>

        <div v-if="err" class="err">{{ err }}</div>
        <div v-if="ok" class="ok">{{ ok }}</div>
      </div>
      <div class="m-foot">
        <button @click="emit('close')">关闭</button>
        <button class="primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存并重连' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.check-line { display: inline-flex; align-items: center; gap: 6px; margin: 14px 0 0; cursor: pointer; }
.check-line input { width: auto; }
</style>
