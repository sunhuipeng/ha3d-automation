'use strict';
/* 运行时拓扑观测测试：
 * ① 模块级记录 → 按 sid+mode+version 分组读取；
 * ② 版本变化重置该组；clear 清空；
 * ③ 纯内存存储：不读写任何磁盘文件；
 * ④ 端到端：正式实例读实体/写实体/写上下文都被观测；
 * ⑤ 影子实例：读实体与上下文被观测，写实体因脚本层写闸拦截而观测不到（预期）。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-topo-'));
const config = require('../server/config');
config.DATA = tmpRoot; // 必须在 require topology/executor 前改，模块加载时锁 DATA
const store = require('../server/scripts/store');
const executor = require('../server/scripts/executor');
const topology = require('../server/scripts/topology');
const runtime = require('../server/lib/runtime');
const scriptRoutes = require('../server/routes/scripts');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };

function makeConnector(callLog) {
  return {
    demo: false,
    getState: (eid) => ({ state: '23', attributes: { entity_id: eid } }),
    listEntities: () => [],
    callService: async (domain, service, data) => {
      callLog.push({ domain, service, entityId: data && data.entity_id });
      return { ok: true };
    },
    isReady: () => true,
  };
}

function waitDone(sid, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (!executor.isRunning(sid)) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('等待脚本结束超时'));
      setTimeout(tick, 40);
    };
    tick();
  });
}

test('模块级：读写实体与上下文按 sid+mode+version 分组记录', () => {
  topology.clear();
  topology.observeRead('a', 'production', 1, 'sensor.x');
  topology.observeRead('a', 'production', 1, 'sensor.y');
  topology.observeRead('a', 'production', 1, 'sensor.x'); // 去重
  topology.observeService('a', 'production', 1, 'switch', 'turn_on', 'switch.x');
  topology.observeContextRead('a', 'production', 1, 'global', 'home.read');
  topology.observeContextRead('a', 'production', 1, 'global', 'home.read'); // 去重
  topology.observeContext('a', 'production', 1, 'global', 'home.x');
  topology.observeRead('a', 'shadow', 2, 'sensor.z');

  const got = topology.get('a').topology;
  assert.deepEqual(got.production.reads, ['sensor.x', 'sensor.y']);
  assert.deepEqual(got.production.writes, ['switch.x']);
  assert.deepEqual(got.production.services, ['switch.turn_on']);
  assert.deepEqual(got.production.contextReads, ['global.home.read']);
  assert.deepEqual(got.production.contexts, ['global.home.x']);
  assert.equal(got.production.version, 1);
  assert.deepEqual(got.shadow.reads, ['sensor.z']);
  assert.equal(got.shadow.version, 2);
});

test('版本变化重置该组，不影响其他通道', () => {
  const before = topology.get('a').topology.production;
  assert.equal(before.reads.length, 2);
  topology.observeRead('a', 'production', 2, 'sensor.new'); // v1 → v2
  const after = topology.get('a').topology;
  assert.deepEqual(after.production.reads, ['sensor.new'], '新版本从零开始');
  assert.equal(after.production.version, 2);
  assert.deepEqual(after.shadow.reads, ['sensor.z'], '影子组不受影响');
});

test('clear 清空指定脚本 / 全部', () => {
  topology.clear('a');
  assert.deepEqual(topology.get('a').topology, {});
  topology.observeRead('b', 'production', 1, 'sensor.b');
  topology.clear();
  assert.deepEqual(topology.get('b').topology, {});
});

test('脚本间关系：observeCall / observeTaskDep 按组记录并跳过自环', () => {
  topology.clear();
  topology.observeCall('a', 'production', 1, 'b');
  topology.observeCall('a', 'production', 1, 'b'); // 去重
  topology.observeCall('a', 'production', 1, 'a'); // 自调用跳过
  topology.observeCall('a', 'production', 1, '');  // 空目标跳过
  topology.observeTaskDep('b', 'production', 1, 'a');
  topology.observeTaskDep('b', 'production', 1, 'b'); // 自依赖跳过
  const a = topology.get('a').topology.production;
  assert.deepEqual(a.calls, ['b'], 'ctx.call 目标去重记录');
  assert.deepEqual(a.taskDeps, [], 'taskDep 记在观察者自己组里');
  const b = topology.get('b').topology.production;
  assert.deepEqual(b.taskDeps, ['a'], 'status/require/watch 的依赖目标');
  assert.deepEqual(b.calls, []);
});

test('纯内存存储：观测不产生任何磁盘文件', () => {
  topology.observeRead('c', 'production', 1, 'sensor.c');
  const runtimeDir = path.join(tmpRoot, 'runtime');
  /* 模块已不再读写 topology.json：目录不存在，或存在也没有拓扑文件 */
  const topoFile = path.join(runtimeDir, 'topology.json');
  assert.ok(!fs.existsSync(topoFile), '不应再落盘 topology.json');
  /* 数据在内存里可正常读取 */
  assert.deepEqual(topology.get('c').topology.production.reads, ['sensor.c']);
});

test('端到端：正式实例读实体 / 写实体 / 写上下文都被观测', async () => {
  const calls = [];
  const connector = makeConnector(calls);
  const script = `
    await ctx.ha.state('sensor.live');
    ctx.actions({ turnOn: () => ctx.ha.callService('switch','turn_on',{entity_id:'switch.live'}) });
    await ctx.global.get('home.readSeen');
    const offWatch = ctx.global.watch('home.watchSeen', () => {});
    offWatch();
    await ctx.global.set('home.live', { on: true });
    await ctx.write('turnOn', '开灯', 'n1');
    ctx.log('info','DONE');
  `;
  const rec = store.submit('topoLive', { name: '正式', script, flow: FLOW, kind: 'script', channel: 'production' });
  executor.start('topoLive', rec.version, connector);
  await waitDone('topoLive');

  assert.deepEqual(calls, [{ domain: 'switch', service: 'turn_on', entityId: 'switch.live' }], 'mock 应收到真实写');
  const g = topology.get('topoLive').topology.production;
  assert.ok(g.reads.includes('sensor.live'), '读实体应被观测');
  assert.ok(g.writes.includes('switch.live'), '写实体应被观测');
  assert.ok(g.contexts.includes('global.home.live'), '上下文写入应被观测');
  assert.ok(g.contextReads.includes('global.home.readSeen'), '上下文 get 应被观测');
  assert.ok(g.contextReads.includes('global.home.watchSeen'), '上下文 watch 应被观测');
  assert.ok(g.services.includes('switch.turn_on'));
});

test('端到端：影子实例能观测读实体与上下文，写实体被脚本层拦截故观测不到', async () => {
  const calls = [];
  const connector = makeConnector(calls);
  const script = `
    await ctx.ha.state('sensor.shadowRead');
    await ctx.global.get('home.shadowRead');
    ctx.actions({ turnOn: () => ctx.ha.callService('switch','turn_on',{entity_id:'switch.shadowWrite'}) });
    await ctx.global.set('home.shadow', 1);
    await ctx.write('turnOn', '影子写', 'n1');
    ctx.log('info','DONE');
  `;
  const rec = store.submit('topoShadow', { name: '影子', script, flow: FLOW, kind: 'script', channel: 'shadow' });
  executor.start('topoShadow', rec.version, connector);
  await waitDone('topoShadow');

  assert.equal(calls.length, 0, '影子写不应下发到 HA');
  const g = topology.get('topoShadow').topology.shadow;
  assert.ok(g.reads.includes('sensor.shadowRead'), '读实体仍被观测');
  assert.ok(g.contexts.includes('global.home.shadow'), '上下文写入仍被观测（影子桶）');
  assert.ok(g.contextReads.includes('global.home.shadowRead'), '影子实例的上下文读取也应被观测');
  assert.equal(g.writes.length, 0, '影子写实体观测不到是预期（脚本层写闸拦在动作执行前）');
});

test('展示名映射：接口补 friendly_name，但不污染内存拓扑里的原始实体 ID', () => {
  topology.clear();
  topology.observeRead('topoLabel', 'production', 1, 'sensor.named');
  topology.observeRead('topoLabel', 'production', 1, 'sensor.unknown');
  topology.observeService('topoLabel', 'production', 1, 'switch', 'turn_on', 'switch.named');

  const realGetState = runtime.connector.getState;
  runtime.connector.getState = (id) => {
    if (id === 'sensor.named') return { entity_id: id, state: '23', attributes: { friendly_name: '客厅温度' } };
    if (id === 'switch.named') return { entity_id: id, state: 'on', attributes: { friendly_name: '客厅开关' } };
    return null;
  };
  try {
    const got = scriptRoutes.topologyForDisplay('topoLabel');
    assert.deepEqual(got.topology.production.reads, ['sensor.named', 'sensor.unknown']);
    assert.deepEqual(got.topology.production.writes, ['switch.named']);
    assert.deepEqual(got.entityLabels['sensor.named'], {
      name: '客厅温度',
      label: '客厅温度（sensor.named）',
    });
    assert.deepEqual(got.entityLabels['switch.named'], {
      name: '客厅开关',
      label: '客厅开关（switch.named）',
    });
    assert.equal(got.entityLabels['sensor.unknown'], undefined, 'HA 中找不到实体时回退 entity_id');
  } finally {
    runtime.connector.getState = realGetState;
  }
});

test('全局拓扑：只汇总正式通道、带脚本名、跨脚本实体取名且不污染原始数据', () => {
  topology.clear();
  const p = store.submit('topoGlobalA', { name: '全局甲', script: 'ctx.log("info","a")', flow: FLOW, kind: 'script', channel: 'shadow' });
  store.submit('topoGlobalB', { name: '全局乙', script: 'ctx.log("info","b")', flow: FLOW, kind: 'script', channel: 'shadow' });
  /* A: 正式读 sensor.shared、影子读 sensor.shadowOnly；B: 正式写 switch.shared */
  topology.observeRead('topoGlobalA', 'production', p.version, 'sensor.shared');
  topology.observeRead('topoGlobalA', 'shadow', p.version, 'sensor.shadowOnly');
  topology.observeService('topoGlobalB', 'production', 1, 'switch', 'turn_on', 'switch.shared');
  topology.observeCall('topoGlobalA', 'production', p.version, 'topoGlobalB'); // A 正式调起 B
  topology.observeTaskDep('topoGlobalB', 'production', 1, 'topoGlobalA');      // B 依赖 A 的状态

  const realGetState = runtime.connector.getState;
  runtime.connector.getState = (id) => {
    const names = { 'sensor.shared': '共享温度', 'switch.shared': '共享开关' };
    return names[id] ? { entity_id: id, state: 'x', attributes: { friendly_name: names[id] } } : null;
  };
  try {
    const got = scriptRoutes.topologyForGlobalDisplay();
    assert.ok(got.scripts.topoGlobalA, '正式通道的脚本应出现');
    assert.equal(got.scripts.topoGlobalA.name, '全局甲', '补左侧列表同源的脚本名');
    assert.deepEqual(got.scripts.topoGlobalA.reads, ['sensor.shared'], '只读正式通道的读实体');
    assert.deepEqual(got.scripts.topoGlobalA.writes, [], '不带影子通道数据');
    assert.deepEqual(got.scripts.topoGlobalB.writes, ['switch.shared']);
    assert.deepEqual(got.scripts.topoGlobalA.calls, ['topoGlobalB'], '脚本间调用边透传');
    assert.deepEqual(got.scripts.topoGlobalB.taskDeps, ['topoGlobalA'], '脚本间状态依赖透传');
    assert.equal(got.scriptNames.topoGlobalB, '全局乙', 'scriptNames 供远端脚本节点显示友好名');
    assert.equal(got.entityLabels['sensor.shared'].name, '共享温度', '跨脚本实体补友好名');
    assert.equal(got.entityLabels['sensor.shadowOnly'], undefined, '影子通道实体不进入全局映射');
    assert.deepEqual(topology.get('topoGlobalA').topology.production.reads, ['sensor.shared'], '原始拓扑未被展示名污染');
  } finally {
    runtime.connector.getState = realGetState;
  }
});
