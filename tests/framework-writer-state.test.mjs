'use strict';
/* global.watch 写者状态折叠专项测试（2026-11-27 全链路改造②③）：
 * 注册 withMeta 拉写者缓存 + 回放带真实 writerSid；contextWriterState 事件折叠进
 * 同一回调（info.type='writerState'，value=prev=当前存量值）；非 running 持续
 * debounceMs 才上报（到点 taskStatus 复查），恢复 running 立即上报并取消计时。
 * 复用 mock 宿主模式（fork runner.js，不连接真实 HA）。 */
import { fork } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, '../server/scripts/runner.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runWithMockHost(script, { meta = {}, onRequest, onSubscribe } = {}) {
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
      resolve({ logs, text: logs.map((l) => l.message).join('\n') });
    };
    child.on('message', (msg) => {
      if (msg.type === 'request') {
        Promise.resolve()
          .then(() => onRequest ? onRequest(msg.action, msg.data, child) : null)
          .then((result) => child.send({ type: 'reply', id: msg.id, ok: true, result }))
          .catch((e) => child.send({ type: 'reply', id: msg.id, ok: false, error: String(e && e.message || e) }));
      }
      if (msg.type === 'log') logs.push(msg);
      if (msg.type === 'contextSubscribe' && onSubscribe) onSubscribe(msg, child);
      if (msg.type === 'done') finish();
    });
    timer = setTimeout(finish, 6000);
    child.send({ type: 'run', script, meta: { version: 1, dryRun: true, sid: 'consumer', ...meta } });
  });
}

const KEY = 'home.p';

test('注册回放带存储的真实写者身份（withMeta）', async () => {
  const { text } = await runWithMockHost(`
    ctx.global.watch('${KEY}', (v, prev, info) => {
      ctx.log('info', 'W:' + v + ':' + prev + ':' + info.writerSid + ':' + (info.source || 'event'));
    });
    await ctx.sleep(150);
  `, {
    onRequest: (action) => (action === 'contextGet'
      ? { v: 'on', w: 'm7orioe9', ws: 'running' }  // 宿主 withMeta 回执：值 + 写者 + 写者状态
      : null),
  });
  assert.match(text, /W:on:null:m7orioe9:replay/, '回放 info.writerSid 来自存储层写者章');
});

test('写者失效防抖：短抖动取消不上报；持续失效到点复查后上报 down', async () => {
  const { text } = await runWithMockHost(`
    ctx.global.watch('${KEY}', (v, prev, info) => {
      ctx.log('info', 'W:' + (info.type || 'value') + ':' + (info.state || info.source || 'ev') + ':' + v + ':' + prev);
    }, { debounceMs: 150 });
    await ctx.sleep(800);
  `, {
    onRequest: (action, data) => {
      if (action === "contextGet") return data.withMeta ? { v: "on", w: "m7", ws: "running" } : "on";
      if (action === 'taskStatus') return { state: data.scriptId === 'm7' ? 'stopped' : 'running' }; // 到点复查仍失效
      return null;
    },
    onSubscribe: (msg, child) => {
      if (msg.key !== KEY) return;
      setTimeout(() => child.send({ type: 'contextWriterState', scope: 'global', key: KEY, value: 'on', prev: 'on', scriptId: 'm7', state: 'stopped', namespace: 'production' }), 100);  // 失效（起防抖）
      setTimeout(() => child.send({ type: 'contextWriterState', scope: 'global', key: KEY, value: 'on', prev: 'on', scriptId: 'm7', state: 'running', namespace: 'production' }), 220);  // 120ms 内恢复：取消
      setTimeout(() => child.send({ type: 'contextWriterState', scope: 'global', key: KEY, value: 'on', prev: 'on', scriptId: 'm7', state: 'stopped', namespace: 'production' }), 320);  // 真失效：持续 >150ms
    },
  });
  const seq = (text.match(/W:[a-zA-Z]+:[a-zA-Z]+/g) || []).join(',');
  assert.equal(seq,
    'W:value:replay,W:writerState:running,W:writerState:stopped',
    '实际序列：' + seq);
  assert.match(text, /W:writerState:stopped:on:on/, 'down 事件 value=prev=当前存量值（旧消费者兼容形态）');
});

test('防抖到点复查已恢复 running → 不上报 down（静默复位）', async () => {
  const { text } = await runWithMockHost(`
    ctx.global.watch('${KEY}', (v, prev, info) => {
      if (info.type === 'writerState') ctx.log('info', 'WS:' + info.state);
    }, { debounceMs: 120 });
    await ctx.sleep(500);
  `, {
    onRequest: (action, data) => {
      if (action === "contextGet") return data.withMeta ? { v: "on", w: "m7", ws: "running" } : "on";
      /* 防抖到点复查：写者实际已恢复 running（模拟漏收 up 事件的竞态） */
      if (action === 'taskStatus') return { state: 'running' };
      return null;
    },
    onSubscribe: (msg, child) => {
      if (msg.key !== KEY) return;
      setTimeout(() => child.send({ type: 'contextWriterState', scope: 'global', key: KEY, value: 'on', prev: 'on', scriptId: 'm7', state: 'stopped', namespace: 'production' }), 50);
    },
  });
  assert.doesNotMatch(text, /WS:stopped/, '复查 running：不上报 down');
  assert.doesNotMatch(text, /WS:running/, '静默复位：也不上报多余 up');
});

test('写者重启（down 已上报后）恢复 running 立即上报 up', async () => {
  const { text } = await runWithMockHost(`
    ctx.global.watch('${KEY}', (v, prev, info) => {
      if (info.type === 'writerState') ctx.log('info', 'WS:' + info.state + ':' + info.reason);
    }, { debounceMs: 100 });
    await ctx.sleep(700);
  `, {
    onRequest: (action, data) => {
      if (action === "contextGet") return data.withMeta ? { v: "on", w: "m7", ws: "running" } : "on";
      if (action === 'taskStatus') return { state: 'stopped' };
      return null;
    },
    onSubscribe: (msg, child) => {
      if (msg.key !== KEY) return;
      setTimeout(() => child.send({ type: 'contextWriterState', scope: 'global', key: KEY, value: 'on', prev: 'on', scriptId: 'm7', state: 'stopped', namespace: 'production' }), 50);   // 失效
      setTimeout(() => child.send({ type: 'contextWriterState', scope: 'global', key: KEY, value: 'on', prev: 'on', scriptId: "m7", state: "running", namespace: "production", reason: "started" }), 300);  // 到点上报后恢复
    },
  });
  const seq = (text.match(/WS:(running|stopped)/g) || []).join(',');
  assert.equal(seq, 'WS:stopped,WS:running', '实际序列：' + seq);
  assert.match(text, /WS:running:started/, 'up 事件保留宿主 reason');
});

test('注册时写者已非 running：同样过防抖后才上报（启动即失效场景）', async () => {
  const { text } = await runWithMockHost(`
    ctx.global.watch('${KEY}', (v, prev, info) => {
      if (info.type === 'writerState') ctx.log('info', 'WS:' + info.state);
    }, { debounceMs: 120 });
    await ctx.sleep(500);
  `, {
    onRequest: (action, data) => {
      if (action === "contextGet") return data.withMeta ? { v: "on", w: "m7", ws: "stopped" } : "on"; // 注册即写者已停
      if (action === 'taskStatus') return { state: 'stopped' };
      return null;
    },
  });
  const seq = (text.match(/WS:(running|stopped)/g) || []).join(',');
  assert.equal(seq, 'WS:stopped', '实际序列：' + seq);
});

test('旧消费者兼容：writerState 事件被当作"值没变的通知"消化，裁决不变', async () => {
  const { text } = await runWithMockHost(`
    /* audr v4（旧版）的典型回调形态：不认识 writerState，按值变化处理 */
    ctx.global.watch('${KEY}', (v, prev, info) => {
      ctx.log('info', 'FACT:' + (v === true) + ':type=' + (info.type || 'none'));
    }, { debounceMs: 100 });
    await ctx.sleep(400);
  `, {
    onRequest: (action, data) => {
      if (action === "contextGet") return data.withMeta ? { v: true, w: "m7", ws: "running" } : true;
      if (action === 'taskStatus') return { state: 'stopped' };
      return null;
    },
    onSubscribe: (msg, child) => {
      if (msg.key !== KEY) return;
      setTimeout(() => child.send({ type: 'contextWriterState', scope: 'global', key: KEY, value: true, prev: true, scriptId: 'm7', state: 'stopped', namespace: 'production' }), 50);
    },
  });
  const seq = (text.match(/FACT:(true|false):type=\w+/g) || []).join(',');
  assert.equal(seq, 'FACT:true:type=none,FACT:true:type=writerState', '实际序列：' + seq);
});

test('写者章迟到补建：注册时写者未知，首个带 writerSid 的值事件补建缓存，后续 down 正常防抖上报', async () => {
  const { text } = await runWithMockHost(`
    ctx.global.watch('${KEY}', (v, prev, info) => {
      const kind = info.type || 'value';
      ctx.log('info', 'E:' + kind + ':' + (info.state || info.source || 'ev'));
    }, { debounceMs: 120 });
    await ctx.sleep(900);
  `, {
    onRequest: (action, data) => {
      /* 注册时桶值无写者（存量键未重写的过渡窗口）：withMeta 回 w=null */
      if (action === 'contextGet') return data.withMeta ? { v: true, w: null, ws: null } : true;
      if (action === 'taskStatus') return { state: 'stopped' }; // 防抖到点复查仍失效
      return null;
    },
    onSubscribe: (msg, child) => {
      if (msg.key !== KEY) return;
      /* 先来一个带 writerSid 的值事件（写者首次重写）→ 补建缓存；
       * 随后 down：修复前会因缓存缺失被静默吞掉（up 报、down 不报的不对称） */
      setTimeout(() => child.send({ type: 'contextChange', scope: 'global', key: KEY, value: true, prev: true, writerSid: 'm7', namespace: 'production' }), 50);
      setTimeout(() => child.send({ type: 'contextWriterState', scope: 'global', key: KEY, value: true, prev: true, scriptId: 'm7', state: 'stopped', namespace: 'production' }), 200);  // 起防抖
      setTimeout(() => child.send({ type: 'contextWriterState', scope: 'global', key: KEY, value: true, prev: true, scriptId: 'm7', state: 'running', namespace: 'production' }), 260);   // 抖动恢复：取消
      setTimeout(() => child.send({ type: 'contextWriterState', scope: 'global', key: KEY, value: true, prev: true, scriptId: 'm7', state: 'stopped', namespace: 'production' }), 380);   // 真失效：到点上报
    },
  });
  const seq = (text.match(/E:(value|writerState):(replay|ev|running|stopped)/g) || []).join(',');
  assert.equal(seq, 'E:value:replay,E:value:ev,E:writerState:running,E:writerState:stopped', '实际序列：' + seq);
});
