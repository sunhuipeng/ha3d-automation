'use strict';
/* 虚拟时钟测试：按序触发、同刻排序、回调内新排定时器、interval、guard、真实 Date 不虚拟化。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { VirtualClock } = require('../server/sim/clock.js');

test('虚拟时钟：advance 按 dueAt 顺序触发，now/iso 与 startAt 同口径', async () => {
  const clock = new VirtualClock({ startAt: '2026-11-26T20:29:55+08:00' });
  const hits = [];
  clock.setTimeout(() => hits.push('b'), 20);
  clock.setTimeout(() => hits.push('a'), 10);
  clock.setTimeout(() => hits.push('c'), 30);
  const r = await clock.advance(30);
  assert.deepEqual(hits, ['a', 'b', 'c']);
  assert.equal(r.now, 30);
  assert.equal(clock.elapsed, 30);
  assert.equal(clock.date().getHours(), 20);
  assert.equal(clock.date().getSeconds(), 55);
  assert.match(r.iso, /12:29:55\.030Z/); // UTC 口径的 ISO（+08:00 → -8h），推进 30ms
});

test('虚拟时钟：同刻定时器按序号（注册顺序）触发', async () => {
  const clock = new VirtualClock({ startAt: 0 });
  const hits = [];
  clock.setTimeout(() => hits.push(1), 10);
  clock.setTimeout(() => hits.push(2), 10);
  clock.setTimeout(() => hits.push(3), 10);
  await clock.advance(10);
  assert.deepEqual(hits, [1, 2, 3]);
});

test('虚拟时钟：回调内新排定时器在本次 advance 内触发', async () => {
  const clock = new VirtualClock({ startAt: 0 });
  const hits = [];
  clock.setTimeout(() => {
    hits.push('outer');
    clock.setTimeout(() => hits.push('inner'), 5);
  }, 10);
  await clock.advance(20);
  assert.deepEqual(hits, ['outer', 'inner']);
});

test('虚拟时钟：advance 未到目标时刻的定时器保留，timerList 可读', async () => {
  const clock = new VirtualClock({ startAt: 0 });
  clock.setTimeout(() => {}, 50, );
  await clock.advance(10);
  const list = clock.timerList();
  assert.equal(list.length, 1);
  assert.equal(list[0].dueAt, 50);
  assert.equal(clock.elapsed, 10);
});

test('虚拟时钟：clearTimeout 取消后不再触发', async () => {
  const clock = new VirtualClock({ startAt: 0 });
  let hit = 0;
  const id = clock.setTimeout(() => { hit += 1; }, 10);
  assert.equal(clock.clearTimeout(id), true);
  await clock.advance(20);
  assert.equal(hit, 0);
});

test('虚拟时钟：setInterval 按周期重复触发', async () => {
  const clock = new VirtualClock({ startAt: 0 });
  let n = 0;
  clock.setInterval(() => { n += 1; }, 10);
  await clock.advance(35);
  assert.equal(n, 3); // 10/20/30
});

test('虚拟时钟：label 写入 timerList，供快照观测', async () => {
  const clock = new VirtualClock({ startAt: 0 });
  const id = clock.setTimeout(() => {}, 10);
  clock.label(id, '满足计时');
  assert.equal(clock.timerList()[0].label, '满足计时');
});

test('虚拟时钟：0ms 自递归触发同刻上限报错，不死锁', async () => {
  const clock = new VirtualClock({ startAt: 0, maxSameTick: 20 });
  const loop = () => clock.setTimeout(loop, 0);
  clock.setTimeout(loop, 0);
  await assert.rejects(() => clock.advance(1), /同刻触发超限/);
});

test('虚拟时钟：步数上限生效', async () => {
  const clock = new VirtualClock({ startAt: 0, maxSteps: 5, maxSameTick: 1000 });
  for (let i = 1; i <= 20; i += 1) clock.setTimeout(() => {}, i);
  await assert.rejects(() => clock.advance(20), /步数超限/);
});

test('虚拟时钟：真实 setImmediate 仍可用（drain 不锁死主进程）', async () => {
  const clock = new VirtualClock({ startAt: 0 });
  clock.setTimeout(async () => { await Promise.resolve(); }, 5);
  const r = await Promise.race([
    clock.advance(5).then(() => 'done'),
    new Promise((res) => setTimeout(() => res('timeout'), 500)),
  ]);
  assert.equal(r, 'done');
});
