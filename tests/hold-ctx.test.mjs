'use strict';
/* ctx.hold 语义测试：真实 fork runner + mock 主进程 IPC，不连真实 HA。
 * 覆盖：值模式读写、condition 投影（含内部读 HA）、翻转重置计时、到点复核、
 * 并发不重入、cancel 清理、watcher 翻转通知、conv setter 不破坏只读 getter。
 * 注意：hold 不内置实体监听，raw 只由脚本 h.value = x 写入。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, '../server/scripts/runner.js');

function runScript(script, { states = {}, ms = 5000, stopAfterMs = 0 } = {}) {
  return new Promise((resolve) => {
    const child = fork(RUNNER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, HA3D_RUNNER: '1' } });
    const logs = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (e) {}
      resolve({ logs, text: logs.map((l) => l.message).join('\n') });
    };
    child.on('message', (msg) => {
      if (msg.type === 'request') {
        const { id, action, data } = msg;
        if (action === 'getState') return child.send({ type: 'reply', id, ok: true, result: states[data.entityId] || null });
        return child.send({ type: 'reply', id, ok: true, result: null });
      }
      /* 订阅后立即回放一条当前状态，模拟 HA 推送（用于验证脚本自己 ctx.watch 驱动 hold） */
      if (msg.type === 'subscribe') {
        const s = states[msg.entityId];
        if (s) setTimeout(() => child.send({ type: 'state', entityId: msg.entityId, state: s, prev: null }), 10);
        return;
      }
      if (msg.type === 'log') logs.push(msg);
      if (msg.type === 'done') finish();
    });
    child.send({ type: 'run', script, meta: { version: 1, dryRun: true, cbTimeoutMs: 500 } });
    if (stopAfterMs > 0) setTimeout(() => child.send({ type: 'stop' }), stopAfterMs);
    setTimeout(finish, ms);
  });
}

test('值模式：写 raw 后不满时长读到旧值，连续满时长后稳定值翻转', async () => {
  const { text } = await runScript(`
    const h = ctx.hold(120);
    ctx.log('info', 'INIT:' + h.value);
    h.value = true;
    ctx.log('info', 'IMM:' + h.value);
    await ctx.sleep(50);
    ctx.log('info', 'HALF:' + h.value);
    await ctx.sleep(130);
    ctx.log('info', 'DONE:' + h.value);
  `);
  assert.match(text, /INIT:false/);
  assert.match(text, /IMM:false/, '写入后立刻读应仍是旧稳定值');
  assert.match(text, /HALF:false/, '未满时长不翻转');
  assert.match(text, /DONE:true/, '连续满时长后翻转');
});

test('翻转即重置：中途 signal 翻转则计时从 0 重来', async () => {
  const { text } = await runScript(`
    const h = ctx.hold(150);
    h.watch((v, prev) => ctx.log('info', 'FLIP:' + prev + '>' + v));
    h.value = true;
    await ctx.sleep(90);          // 距首次翻转 90ms，尚未满 150ms
    h.value = false;              // 翻转，计时清零
    await ctx.sleep(90);          // 若未重置此时已满 150ms 会误翻 true
    ctx.log('info', 'AFTER_RESET:' + h.value);
    await ctx.sleep(90);
    ctx.log('info', 'STABLE:' + h.value);
  `);
  assert.match(text, /AFTER_RESET:false/, '翻转后重新计时，旧计时不得触发');
  assert.match(text, /STABLE:false/);
  assert.doesNotMatch(text, /FLIP:false>true/, 'true 从未连续满 150ms，不应翻到 true');
});

test('condition 投影：raw 经 condition 变成 signal 后再判持续', async () => {
  const { text } = await runScript(`
    const h = ctx.hold({ ms: 100, condition: (raw) => ctx.num(raw) > 800 });
    h.value = 900;
    await ctx.sleep(170);
    ctx.log('info', 'HIGH:' + h.value);
    h.value = 700;                // 条件翻回 false
    await ctx.sleep(170);
    ctx.log('info', 'LOW:' + h.value);
  `);
  assert.match(text, /HIGH:true/);
  assert.match(text, /LOW:false/);
});

test('condition 内自己读 HA：框架不内置监听，实体由脚本在 condition 里异步读', async () => {
  const states = { 'p.wok': { state: '900' }, 'p.oven': { state: '300' } };
  const { text } = await runScript(`
    const h = ctx.hold({ ms: 100, condition: async () => {
      const sum = (await ctx.ha.num('p.wok')) + (await ctx.ha.num('p.oven'));
      return sum > 800;
    } });
    await ctx.sleep(180);
    ctx.log('info', 'HA:' + h.value + ' RAW:' + h.state().raw);
  `, { states });
  assert.match(text, /HA:true RAW:false/, 'condition 内部读 HA 求和应为 true；raw 保持写入值');
});

test('脚本自己 ctx.watch 驱动：实体变化时写 raw，翻转重置计时', async () => {
  const states = { 'b.stove': { state: 'Busy' } };
  const { text } = await runScript(`
    const h = ctx.hold({ ms: 80, condition: (raw) => raw === 'Busy' });
    ctx.watch(['b.stove'], (s) => { h.value = s.state; });
    await ctx.sleep(150);
    ctx.log('info', 'BUSY:' + h.value + ' RAW:' + h.state().raw);
  `, { states });
  assert.match(text, /BUSY:true RAW:Busy/);
});

test('到点复核：到点会再跑一次 condition，仍满足才确认稳定翻转', async () => {
  const { text } = await runScript(`
    let reads = 0;
    const h = ctx.hold({ ms: 100, condition: () => { reads++; return true; } });
    h.value = 'x';
    await ctx.sleep(50);
    const midReads = reads;       // 翻转时跑一次
    await ctx.sleep(120);
    ctx.log('info', 'V1:' + h.value + ' MID:' + midReads + ' FINAL:' + reads);
  `);
  // 翻转时 1 次、到点复核至少再 1 次；稳定值 true
  assert.match(text, /V1:true/, '连续满足后稳定值翻 true');
  assert.match(text, /FINAL:([2-9]|\d\d+)/, 'condition 被重复求值（到点复核）');
});

test('watcher 只在稳定值翻转时通知，带 (新值, 旧值)', async () => {
  const { text } = await runScript(`
    const h = ctx.hold(80);
    h.watch((v, prev) => ctx.log('info', 'W:' + prev + '>' + v));
    h.value = true;
    await ctx.sleep(60);          // 翻转 signal，但 stable 未变
    ctx.log('info', 'NO_WATCH_YET');
    await ctx.sleep(100);         // stable 翻 true → 应有一次 watch
    const off = h.watch((v) => ctx.log('info', 'SECOND'));
    off();                        // 注册后立即注销
    h.value = false;
    await ctx.sleep(180);         // stable 翻 false
    h.value = true;
    await ctx.sleep(180);         // 再翻 true，SECOND 不应响
    ctx.log('info', 'END');
  `);
  assert.match(text, /NO_WATCH_YET/);
  assert.match(text, /W:false>true/);
  assert.match(text, /W:true>false/);
  assert.doesNotMatch(text, /SECOND/, '注销后的 watcher 不应再触发');
  const wTrue = (text.match(/W:false>true/g) || []).length;
  assert.equal(wTrue, 2, '两次独立的 false→true 稳定翻转各通知一次，不重复泛滥');
});

test('stop：脚本关闭时 hold 的定时器被统一清理，稳定值不再翻转', async () => {
  const { text } = await runScript(`
    const h = ctx.hold({ ms: 200, label: 'stop-test' });
    h.watch((v) => ctx.log('info', 'WATCH:' + v));
    h.value = true;               // 正常会在 200ms 后翻 true
    await ctx.sleep(400);
    ctx.log('info', 'END:' + h.value);
  `, { stopAfterMs: 40 });       // 40ms 时 stop —— 早于确认点
  assert.doesNotMatch(text, /稳定值 false → true/, 'stop 后到点定时器不得再触发确认');
  assert.doesNotMatch(text, /WATCH:true/, 'stop 后不得再通知 watcher');
});

test('cancel：清 timer 与 watcher，值不再翻转', async () => {
  const { text } = await runScript(`
    const h = ctx.hold(80);
    h.watch(() => ctx.log('info', 'SHOULD_NOT'));
    h.value = true;
    const ok = h.cancel();
    await ctx.sleep(160);
    ctx.log('info', 'CANCEL:' + ok + ':' + h.value + ':' + h.state().dead);
    h.value = false;              // cancel 后写入无效
    await ctx.sleep(40);
    ctx.log('info', 'AFTER:' + h.value);
  `);
  assert.match(text, /CANCEL:true:false:true/);
  assert.match(text, /AFTER:false/);
  assert.doesNotMatch(text, /SHOULD_NOT/);
});

test('conv setter：hold 句柄 value 可写，但只读 getter（dryRun 等）仍不可写', async () => {
  const { text } = await runScript(`
    const h = ctx.hold(80);
    h.value = true;               // 可写：验证 setter 确实搬进 realm
    ctx.log('info', 'RAW:' + h.state().raw);
    const before = ctx.dryRun;
    try { ctx.dryRun = false; } catch (e) {}  // 只读 getter：不可写（非严格模式静默失败）
    ctx.log('info', 'DRY:' + before + '>' + ctx.dryRun);
    ctx.log('info', 'STOPPED:' + ctx.stopped);
  `);
  assert.match(text, /RAW:true/, 'hold.value setter 必须生效');
  assert.match(text, /DRY:true>true/, '只读 getter 不应被 setter 搬运破坏');
  assert.match(text, /STOPPED:false/);
});

test('并发不重入：连续多次赋值不重复排定时器，稳定值只翻一次', async () => {
  const { text } = await runScript(`
    const h = ctx.hold(90);
    let flips = 0;
    h.watch(() => flips++);
    h.value = true;
    h.value = true;
    h.value = true;
    await ctx.sleep(180);
    ctx.log('info', 'FLIPS:' + flips + ':' + h.value);
  `);
  assert.match(text, /FLIPS:1:true/);
});
