'use strict';
/* 前端 store 的纯逻辑测试（不跑浏览器、不发请求）：
 * 验证方式（follow/simulate）在运行态派生与日志源切换上的语义。
 * 这些是前端徽章/切换按钮唯一容易出错的地方——状态口径漂移不会有编译错误，只能测出来。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from '../client/node_modules/pinia/dist/pinia.mjs';
import { useScriptStore } from '../client/src/stores/scripts.js';

function seedStore() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const s = useScriptStore();
  s.current = { id: 'demo', version: 1, status: 'stopped', meta: { channel: 'shadow' } };
  s.shadowVersion = 1;
  s.productionVersion = null;
  s.runningVersions = [];
  s.versions = [{ version: 1, channel: 'shadow', status: 'stopped' }];
  s.list = [{ id: 'demo', shadowVersion: 1, runningVersions: [] }];
  s.logs = [];
  s.logsSource = 'real';
  return s;
}

test('store：simulate 状态事件写入 verifyMode，currentVerifyMode 派生正确', () => {
  const s = seedStore();
  s.setStatus('running', 1, 'shadow', 'simulate');
  assert.equal(s.current.status, 'running');
  assert.equal(s.runningVersions.length, 1);
  assert.equal(s.runningVersions[0].verifyMode, 'simulate');
  assert.equal(s.currentVerifyMode, 'simulate');
  assert.equal(s.current.running, true);
});

test('store：切换中的 stopped 空窗不把状态降级（回滚到 switching 而非已停止）', () => {
  const s = seedStore();
  s.setStatus('switching', 1, 'shadow', 'simulate');
  assert.equal(s.current.status, 'switching');
  /* 暂停旧实例会先广播 stopped：必须被忽略，否则用户看到"切换中→已停止→运行中"的假崩溃 */
  s.setStatus('stopped', 1, 'shadow');
  assert.equal(s.current.status, 'switching');
  assert.equal(s.runningVersions.length, 1, '切换空窗内实例条目不能丢');
  s.setStatus('running', 1, 'shadow', 'simulate');
  assert.equal(s.current.status, 'running');
});

test('store：切到 simulate 后日志源切到 sim，真实条目被过滤、仿真条目进入', () => {
  const s = seedStore();
  s.logsSource = 'sim';
  s.pushLog({ message: '真实日志', level: 'info' });
  s.pushLog({ message: '仿真日志', level: 'info', sim: true });
  assert.deepEqual(s.logs.map((l) => l.message), ['仿真日志']);
  s.logsSource = 'real';
  s.pushLog({ message: '真实二', level: 'info' });
  s.pushLog({ message: '仿真二', level: 'info', sim: true });
  assert.deepEqual(s.logs.map((l) => l.message), ['仿真日志', '真实二']);
});

test('store：正式实例没有仿真概念（logsSourceForCurrent 只在 simulate 时读 sim）', () => {
  const s = seedStore();
  s.current.meta = { channel: 'production' };
  s.setStatus('running', 1, 'production');
  assert.equal(s.currentVerifyMode, 'follow');
  assert.equal(s.logsSourceForCurrent(), 'real');
  s.runningVersions = [{ version: 1, mode: 'shadow', verifyMode: 'simulate' }];
  assert.equal(s.logsSourceForCurrent(), 'sim');
});
