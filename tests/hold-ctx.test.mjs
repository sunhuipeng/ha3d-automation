'use strict';
/* ctx.hold 语义测试：真实 fork runner + mock 主进程 IPC，不连真实 HA。
 * 新语义：期待值/期待条件 + 双边计时；满足持续 satisfyMs 回调一次 true，
 * 不满足持续 unsatisfyMs 回调一次 false（null/0/缺省立即回落）；同一状态不重复回调。
 * 覆盖：默认值模式、expect 值/expect 函数、中途重置、回落时间、立即回落、
 * 回调参数、HA 读值、异常重试、conv setter、cancel/stop 清理、旧语法报错。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, '../server/scripts/runner.js');

function runScript(script, { states = {}, ms = 5000, stopAfterMs = 0, dryRun = true } = {}) {
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
      if (msg.type === 'subscribe') {
        const s = states[msg.entityId];
        if (s) setTimeout(() => child.send({ type: 'state', entityId: msg.entityId, state: s, prev: null }), 10);
        return;
      }
      if (msg.type === 'log') logs.push(msg);
      if (msg.type === 'done') finish();
    });
    child.send({ type: 'run', script, meta: { version: 1, dryRun, cbTimeoutMs: 500 } });
    if (stopAfterMs > 0) setTimeout(() => child.send({ type: 'stop' }), stopAfterMs);
    setTimeout(finish, ms);
  });
}

test('默认值模式：truthy 持续到位回调 true，随后 false 立即回落', async () => {
  const { text } = await runScript(`
    const h = ctx.hold({ satisfyMs: 100 });
    h.watch((s, prev, info) => ctx.log('info', 'W:' + s + ':' + prev + ':' + info.reason + ':' + info.satisfied + ':' + info.satisfied));
    ctx.log('info', 'INIT:' + h.value);
    h.value = true;
    ctx.log('info', 'IMM:' + h.value);
    await ctx.sleep(60);
    ctx.log('info', 'HALF:' + h.value);
    await ctx.sleep(90);
    ctx.log('info', 'DONE:' + h.value);
    h.value = false;
    await ctx.sleep(20);
    const st = h.state();
    ctx.log('info', 'END:' + h.value + ':' + st.active + ':' + st.pending);
  `);
  assert.match(text, /INIT:false/);
  assert.match(text, /IMM:false/, '写入后立刻读仍是旧确认状态');
  assert.match(text, /HALF:false/, '未满时长不切换');
  assert.match(text, /DONE:true/);
  assert.match(text, /W:true:false:satisfied:true:true/);
  assert.match(text, /W:false:true:unsatisfied:false:false/, '默认不满足立即回落');
  assert.match(text, /END:false:false:null/);
});

test('expect 值模式：只有 raw 等于期待值才算满足', async () => {
  const { text } = await runScript(`
    const h = ctx.hold({ satisfyMs:80, expect: 'Busy', unsatisfyMs: null });
    h.watch((s) => ctx.log('info', 'W:' + s));
    h.value = 'Idle';
    await ctx.sleep(120);
    ctx.log('info', 'IDLE:' + h.value);
    h.value = 'Busy';
    await ctx.sleep(130);
    ctx.log('info', 'BUSY:' + h.value);
    h.value = 'Busy';
    await ctx.sleep(130);
    ctx.log('info', 'STILL:' + h.value);
    h.value = 'Idle';
    await ctx.sleep(20);
    ctx.log('info', 'BACK:' + h.value);
  `);
  assert.match(text, /IDLE:false/);
  assert.match(text, /BUSY:true/);
  assert.match(text, /STILL:true/);
  assert.match(text, /BACK:false/);
  assert.equal((text.match(/W:true/g) || []).length, 1, '满足后持续不动只回调一次');
  assert.equal((text.match(/W:false/g) || []).length, 1, '不满足立即回落只回调一次');
});

test('expect 函数：投影后按二态判定', async () => {
  const { text } = await runScript(`
    const h = ctx.hold({ satisfyMs:80, expect: (raw) => ctx.num(raw) > 800, unsatisfyMs: 0, label: 'expect' });
    h.value = 900;
    await ctx.sleep(130);
    ctx.log('info', 'HIGH:' + h.value);
    h.value = 700;
    await ctx.sleep(20);
    ctx.log('info', 'LOW:' + h.value);
  `);
  assert.match(text, /HIGH:true/);
  assert.match(text, /LOW:false/, 'unsatisfyMs=0 立即回落');
});

test('旧语法一律报错：数字首参 / ms / condition / fallMs', async () => {
  const { text } = await runScript(`
    const cases = [
      () => ctx.hold(100),
      () => ctx.hold({ ms: 100, expect: true }),
      () => ctx.hold({ satisfyMs: 100, condition: () => true }),
      () => ctx.hold({ satisfyMs: 100, expect: true, fallMs: 50 }),
    ];
    for (let i = 0; i < cases.length; i++) {
      try { cases[i](); ctx.log('info', 'CASE' + i + ':NO_THROW'); }
      catch (e) { ctx.log('info', 'CASE' + i + ':' + e.message); }
    }
  `);
  assert.doesNotMatch(text, /CASE\d:NO_THROW/, '四种旧写法都必须抛错');
  assert.match(text, /CASE0:ctx\.hold 只接受对象参数/);
  assert.match(text, /CASE1:ctx\.hold 不再支持旧参数 ms/);
  assert.match(text, /CASE2:ctx\.hold 不再支持旧参数 condition/);
  assert.match(text, /CASE3:ctx\.hold 不再支持旧参数 fallMs/);
});

test('中途翻转重置：false 打断 true 后，新 true 从 0 重新计时', async () => {
  const { text } = await runScript(`
    const h = ctx.hold({ satisfyMs:150, expect: true, unsatisfyMs: null });
    h.watch((s) => ctx.log('info', 'W:' + s));
    h.value = true;
    await ctx.sleep(90);
    h.value = false;        // 回到已确认状态：取消满足计时，不回落回调
    await ctx.sleep(60);
    h.value = true;         // 新的一段 true，重新计时
    await ctx.sleep(90);
    ctx.log('info', 'BEFORE:' + h.value);
    await ctx.sleep(90);
    ctx.log('info', 'AFTER:' + h.value);
  `);
  assert.match(text, /BEFORE:false/);
  assert.match(text, /AFTER:true/);
  assert.equal((text.match(/W:true/g) || []).length, 1, '只有新的连续 true 满 150ms 才回调一次');
  assert.equal((text.match(/W:false/g) || []).length, 0, '短暂 false 未产生回落回调');
});

test('回落时间：不满足持续满 unsatisfyMs 才回调 false，中途回满足则取消', async () => {
  const { text } = await runScript(`
    const h = ctx.hold({ satisfyMs:80, unsatisfyMs: 150, expect: true });
    h.watch((s) => ctx.log('info', 'W:' + s));
    h.value = true;
    await ctx.sleep(120);
    h.value = false;
    await ctx.sleep(90);
    ctx.log('info', 'MID:' + h.value + ':' + h.state().pending);
    h.value = true;         // 回落计时被打断，不回调 false
    await ctx.sleep(80);
    ctx.log('info', 'NO_FALSE:' + h.value);
    h.value = false;
    await ctx.sleep(190);
    ctx.log('info', 'FALL:' + h.value);
  `);
  assert.match(text, /MID:true:unsatisfied/, '回落计时中状态仍保持 true');
  assert.match(text, /NO_FALSE:true/);
  assert.match(text, /FALL:false/);
  assert.equal((text.match(/W:true/g) || []).length, 1, '回落被打断时状态仍为 true，不应重复回调 true');
  assert.equal((text.match(/W:false/g) || []).length, 1, '只有持续满回落时间才回调一次 false');
});

test('unsatisfyMs=null：显式声明不满足立即回落', async () => {
  const { text } = await runScript(`
    const h = ctx.hold({ satisfyMs:80, expect: true, unsatisfyMs: null });
    h.watch((s) => ctx.log('info', 'W:' + s));
    h.value = true;
    await ctx.sleep(130);
    h.value = false;
    ctx.log('info', 'IMM:' + h.value);
  `);
  assert.match(text, /W:true/);
  assert.match(text, /IMM:false/);
  assert.match(text, /W:false/);
});

test('回调参数携带 satisfied/prev/info，且 info 含方向与等待时长', async () => {
  const { text } = await runScript(`
    const h = ctx.hold({ satisfyMs:80, expect: true, unsatisfyMs: 120, nodeId: 'n_test', label: 'args' });
    h.watch((s, prev, info) => ctx.log('info',
      'INFO:' + s + ':' + prev + ':' + info.reason + ':' + info.satisfied + ':' +
      (info.value === s) + ':' + (info.ms >= 80) + ':' + info.nodeId));
    h.value = true;
    await ctx.sleep(130);
    h.value = false;
    await ctx.sleep(160);
  `);
  assert.match(text, /INFO:true:false:satisfied:true:true:true:n_test/);
  assert.match(text, /INFO:false:true:unsatisfied:false:true:true:n_test/);
});

test('expect 内自己读 HA：框架不内置监听，条件可 async', async () => {
  const states = { 'p.wok': { state: '900' }, 'p.oven': { state: '300' } };
  const { text } = await runScript(`
    const h = ctx.hold({ satisfyMs:100, expect: async () => {
      const sum = (await ctx.ha.num('p.wok')) + (await ctx.ha.num('p.oven'));
      return sum > 800;
    }, unsatisfyMs: null });
    await ctx.sleep(160);
    ctx.log('info', 'HA:' + h.value + ' RAW:' + h.state().raw);
  `, { states });
  assert.match(text, /HA:true RAW:false/, 'expect 内部读 HA 求和应为 true；raw 保持初始值');
});

test('到点复核 expect 异常：补排重试，不卡在无 timer 的半开状态', async () => {
  const { text } = await runScript(`
    let calls = 0;
    const h = ctx.hold({ satisfyMs:100, expect: () => {
      calls++;
      if (calls === 2) throw new Error('HA 读超时');
      return true;
    }, unsatisfyMs: null });
    h.value = true;
    await ctx.sleep(280);
    const s = h.state();
    ctx.log('info', 'AFTER_ERR:' + h.value + ' CALLS:' + calls + ' ACTIVE:' + s.active + ' REM:' + s.remaining);
  `);
  assert.match(text, /AFTER_ERR:true CALLS:[3-9]/, '异常后应补排重试并确认满足');
  assert.doesNotMatch(text, /ACTIVE:true REM:0/, '不得停在 remaining=0 却无后续复核的半开态');
});

test('init 时 expect 异常：按 satisfyMs 自动重试，不依赖脚本写 raw', async () => {
  const { text } = await runScript(`
    let calls = 0;
    const h = ctx.hold({ satisfyMs:80, expect: () => {
      calls++;
      if (calls === 1) throw new Error('HA 尚未就绪');
      return true;
    }, unsatisfyMs: null });
    await ctx.sleep(280);
    ctx.log('info', 'INIT_RETRY:' + h.value + ' CALLS:' + calls);
  `);
  assert.match(text, /INIT_RETRY:true CALLS:[3-9]/, 'init 异常后应自行重试');
});

test('cancel：清 timer/watcher，值冻结且之后 watch 只拿 noop', async () => {
  const { text } = await runScript(`
    const h = ctx.hold({ satisfyMs:80, expect: true, unsatisfyMs: null });
    h.watch(() => ctx.log('info', 'SHOULD_NOT'));
    h.value = true;
    const before = h.state();
    const ok = h.cancel();
    const after = h.state();
    await ctx.sleep(160);
    const off = h.watch(() => ctx.log('info', 'DEAD_WATCH_FIRED'));
    const off2 = off();
    ctx.log('info', 'CANCEL:' + ok + ':' + before.active + ':' + after.dead + ':' + after.active + ':' + after.remaining + ':' + off2);
    h.value = false;
    await ctx.sleep(40);
    ctx.log('info', 'AFTER:' + h.value);
  `);
  assert.match(text, /CANCEL:true:true:true:false:0:false/);
  assert.match(text, /AFTER:false/);
  assert.doesNotMatch(text, /SHOULD_NOT/);
  assert.doesNotMatch(text, /DEAD_WATCH_FIRED/);
});

test('conv setter：hold 句柄 value 可写，只读 getter 不受影响', async () => {
  const { text } = await runScript(`
    const h = ctx.hold({ satisfyMs:80, expect: true, unsatisfyMs: null });
    h.value = true;
    ctx.log('info', 'RAW:' + h.state().raw);
    const before = ctx.dryRun;
    try { ctx.dryRun = false; } catch (e) {}
    ctx.log('info', 'DRY:' + before + '>' + ctx.dryRun);
    ctx.log('info', 'STOPPED:' + ctx.stopped);
  `);
  assert.match(text, /RAW:true/);
  assert.match(text, /DRY:true>true/);
  assert.match(text, /STOPPED:false/);
});

test('stop：脚本关闭时 hold 定时器统一清理，不再回调', async () => {
  const { text } = await runScript(`
    const h = ctx.hold({ satisfyMs:200, expect: true, unsatisfyMs: null, label: 'stop-test' });
    h.watch((s) => ctx.log('info', 'WATCH:' + s));
    h.value = true;
    await ctx.keepAlive();
  `, { stopAfterMs: 40, ms: 500 });
  assert.doesNotMatch(text, /确认满足：状态 false → true/, 'stop 后到点不得确认');
  assert.doesNotMatch(text, /WATCH:true/, 'stop 后不得通知 watcher');
});

test('stop 后到期的 ctx.after 回调不再执行', async () => {
  const { text } = await runScript(`
    ctx.after(180, () => ctx.log('info', 'AFTER_FIRED'));
    ctx.log('info', 'ARMED');
    await ctx.keepAlive();
  `, { stopAfterMs: 40, ms: 500 });
  assert.match(text, /ARMED/);
  assert.doesNotMatch(text, /AFTER_FIRED/, 'stop 后到点的回调不得执行');
});

test('stop 后 ctx.write 不再下发真实动作', async () => {
  const { text } = await runScript(`
    ctx.actions({ writeIt: () => ctx.log('info', 'REAL_WRITE') });
    while (!ctx.stopped) {
      try { await ctx.ha.num('x'); } catch (e) { break; }
    }
    const ok = await ctx.write('writeIt', 'after stop');
    ctx.log('info', 'POST_STOP:' + ctx.stopped + ':' + ok);
  `, { dryRun: false, stopAfterMs: 40, ms: 600 });
  assert.match(text, /POST_STOP:true:false/, 'stop 后写操作应被拦下');
  assert.doesNotMatch(text, /REAL_WRITE/, 'stop 后不得下发真实设备控制');
  assert.match(text, /动作已跳过（实例已停止）/);
});
