'use strict';
/* ctx.watch 实体防抖合并专项测试（2026-11-28 下沉）：
 * ① 缺省 300ms 尾沿防抖：HA 一波推送里多个被订阅实体先后变化（water_heater 本体 +
 *    模板温度传感器各发一次 state_changed），回调只触发一次，取最后一个事件的状态，
 *    info = { merged, entityIds }。
 * ② { debounceMs: 0 } 关闭防抖 → 逐事件回调（第 3 参数退化为触发实体 id）。
 * ③ 间隔超过防抖窗口的两次推送 → 各自独立回调（merged=1）。
 * 复用 mock 宿主模式（fork runner.js，不连接真实 HA）；防抖计时在 fork 模式下走真实时钟。 */
import { fork } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, '../server/scripts/runner.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runWithMockHost(script, { onEntity } = {}) {
  return new Promise((resolve) => {
    const child = fork(RUNNER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, HA3D_RUNNER: '1' } });
    const logs = [];
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch (e) {}
      resolve({ text: logs.map((l) => l.message).join('\n') });
    };
    child.on('message', (msg) => {
      if (msg.type === 'request') {
        child.send({ type: 'reply', id: msg.id, ok: true, result: null });
      }
      if (msg.type === 'log') logs.push(msg);
      if (msg.type === 'subscribe' && onEntity) onEntity(msg, child);
      if (msg.type === 'done') finish();
    });
    timer = setTimeout(finish, 6000);
    child.send({ type: 'run', script, meta: { version: 1, dryRun: true, sid: 'self' } });
  });
}

test('缺省 300ms：同波双实体推送合并为一次回调，info.merged=2 且状态取最后一个事件', async () => {
  const { text } = await runWithMockHost(`
    ctx.watch(['sensor.temp', 'water_heater.main'], (s, p, info) => {
      ctx.log('info', 'W:' + s.state + ':' + info.merged + ':' + info.entityIds.join('|'));
    });
    await ctx.sleep(800);
  `, {
    onEntity: (msg, child) => {
      if (msg.entityId !== 'sensor.temp') return;
      /* 模拟 water_heater 属性变化 + 模板传感器重算：同波两个实体先后变化 */
      setTimeout(() => child.send({ type: 'state', entityId: 'water_heater.main', state: { state: 'on', current_temperature: 43 }, prev: { state: 'on', current_temperature: 44 } }), 50);
      setTimeout(() => child.send({ type: 'state', entityId: 'sensor.temp', state: { state: '43' }, prev: { state: '44' } }), 90);
    },
  });
  const seq = (text.match(/W:\S+/g) || []).join(',');
  assert.equal(seq, 'W:43:2:water_heater.main|sensor.temp', '实际序列：' + seq);
});

test('{ debounceMs: 0 }：关闭防抖逐事件回调，第 3 参数为触发实体 id', async () => {
  const { text } = await runWithMockHost(`
    ctx.watch(['sensor.a', 'sensor.b'], (s, p, info) => {
      ctx.log('info', 'I:' + info + ':' + s.state);
    }, { debounceMs: 0 });
    await ctx.sleep(500);
  `, {
    onEntity: (msg, child) => {
      if (msg.entityId !== 'sensor.a') return;
      setTimeout(() => child.send({ type: 'state', entityId: 'sensor.a', state: { state: 'on' }, prev: { state: 'off' } }), 40);
      setTimeout(() => child.send({ type: 'state', entityId: 'sensor.b', state: { state: 'off' }, prev: { state: 'on' } }), 70);
    },
  });
  const seq = (text.match(/I:sensor\.[ab]:on/g) || []).concat(text.match(/I:sensor\.[ab]:off/g) || []).join(',');
  assert.equal(seq, 'I:sensor.a:on,I:sensor.b:off', '实际序列：' + seq);
});

test('间隔超过防抖窗口的推送各自独立回调（merged=1）', async () => {
  const { text } = await runWithMockHost(`
    let n = 0;
    ctx.watch(['sensor.c'], (s, p, info) => {
      n += 1;
      ctx.log('info', 'N' + n + ':' + info.merged);
    });
    await ctx.sleep(900);
  `, {
    onEntity: (msg, child) => {
      if (msg.entityId !== 'sensor.c') return;
      setTimeout(() => child.send({ type: 'state', entityId: 'sensor.c', state: { state: '1' }, prev: null }), 50);
      setTimeout(() => child.send({ type: 'state', entityId: 'sensor.c', state: { state: '2' }, prev: { state: '1' } }), 500); // 距首次回调 >300ms
    },
  });
  assert.match(text, /N1:1/);
  assert.match(text, /N2:1/);
});

test('同实体窗口内多次变化只回调一次、尾沿值生效', async () => {
  const { text } = await runWithMockHost(`
    ctx.watch(['sensor.d'], (s) => ctx.log('info', 'D:' + s.state));
    await ctx.sleep(700);
  `, {
    onEntity: (msg, child) => {
      if (msg.entityId !== 'sensor.d') return;
      setTimeout(() => child.send({ type: 'state', entityId: 'sensor.d', state: { state: 'A' }, prev: null }), 40);
      setTimeout(() => child.send({ type: 'state', entityId: 'sensor.d', state: { state: 'B' }, prev: { state: 'A' } }), 70);
      setTimeout(() => child.send({ type: 'state', entityId: 'sensor.d', state: { state: 'C' }, prev: { state: 'B' } }), 100);
    },
  });
  const hits = (text.match(/D:[ABC]\b/g) || []);
  assert.equal(hits.length, 1, '只回调一次，实际：' + hits.join(','));
  assert.match(text, /D:C/, '尾沿值生效');
});
