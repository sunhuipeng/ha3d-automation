'use strict';
/* 端到端验证 runner 的 ctx.dryRun 热切换：
 * fork 真实 runner.js，用 mock 主进程回 IPC（getState 返回模拟值、callService 记账），
 * 验证影子模式拦截写、发 mode 消息切正式后真实下发。全程不连接真实 HA。 */
import path from 'node:path';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RUNNER = path.join(__dirname, '../server/scripts/runner.js');
const script = fs.readFileSync(path.join(__dirname, './fixtures/water-heater-avoid.dryrun.js'), 'utf8');

// 模拟实体状态：B 组电磁炉 Busy 命中（开机即规避）
const states = {
  'sensor.cuco_cn_695113573_v3_electric_power_p_11_2': '0',
  'sensor.yutai_cn_2052307013_jdls1_electric_power_p_3_2': '0',
  'sensor.cuco_cn_671705534_v3_electric_power_p_11_2': '0',
  'sensor.chunmi_cn_113056718_v1_status_p_2_1': 'Off', // 初始不命中，避免提前进入规避状态
  'climate.lumi_cn_584491601_mcn02': 'off',
  'input_boolean.re_shui_qi_bao_wen_mo_shi': 'on',
  'sensor.dian_re_shui_qi_re_shui_qi_mu_biao_wen_du': '65',
};

const callLog = [];
const child = fork(RUNNER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, HA3D_RUNNER: '1' } });
let phase = 1; // 1=影子阶段, 2=正式阶段
let waitTimer = null;

child.on('message', (msg) => {
  if (msg.type === 'request') {
    const { id, action, data } = msg;
    if (action === 'getState') return child.send({ type: 'reply', id, ok: true, result: { state: states[data.entityId] || '0', attributes: {} } });
    if (action === 'callService') {
      callLog.push({ phase, domain: msg.data.domain, service: msg.data.service, entity: msg.data.data && msg.data.data.entity_id, at: Date.now() });
      return child.send({ type: 'reply', id, ok: true, result: {} });
    }
    return child.send({ type: 'reply', id, ok: true, result: null });
  }
  if (msg.type === 'log' && /规避触发|真实写操作|影子·拦截|运行模式切换/.test(msg.message)) {
    console.log(`  [P${phase}] ${msg.message}`);
  }
});

// 启动：影子模式
child.send({ type: 'run', script, meta: { version: 2, dryRun: true, kind: 'automation' } });

// 3 秒后确认影子阶段无调用，然后切正式，再制造首次命中
setTimeout(() => {
  const shadowCalls = callLog.filter((c) => c.phase === 1).length;
  console.log('\n=== 影子阶段（未命中）callService 次数 =', shadowCalls, '(期望 0) ===');
  console.log('切换到正式模式（发 mode 消息，不重启）...');
  phase = 2;
  child.send({ type: 'mode', dryRun: false });
  // 切正式后才让电磁炉 Busy 首次命中，触发 enterAvoid（avoiding=false）
  setTimeout(() => {
    states['sensor.chunmi_cn_113056718_v1_status_p_2_1'] = 'Busy';
  }, 300);
}, 3000);

setTimeout(() => {
  const shadowCalls = callLog.filter((c) => c.phase === 1).length;
  const liveCalls = callLog.filter((c) => c.phase === 2).length;
  console.log('\n=== 最终统计 ===');
  console.log('影子阶段真实 callService:', shadowCalls);
  console.log('正式阶段真实 callService:', liveCalls);
  if (liveCalls) console.log('正式阶段调用明细:', JSON.stringify(callLog.filter((c) => c.phase === 2)));
  const whOff = callLog.filter((c) => c.phase === 2 && c.domain === 'water_heater' && c.service === 'turn_off').length;
  // 规避只下发一次关热水器；本项目私有状态不进 HA helper，因此不再有 input_boolean 写
  const ok = shadowCalls === 0 && liveCalls === 1 && whOff === 1;
  console.log(ok ? '\n✅ 影子拦截 + 正式热切换下发 均通过' : '\n❌ 验证失败');
  try { child.send({ type: 'stop' }); } catch (e) {}
  setTimeout(() => { try { child.kill(); } catch (e) {} process.exit(ok ? 0 : 1); }, 300);
}, 7500);
