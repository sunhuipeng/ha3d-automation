import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wsUrl } from '../server/ha/connector.js';
/* lockKey 已不在 executor 导出面（仅内部使用，审计 P1 死导出清理）：改测共享实现 inst-key 同款拼接 */
import { instKey } from '../server/scripts/inst-key.js';

test('wsUrl：http → ws 并指向 /api/websocket', () => {
  assert.equal(wsUrl('http://192.168.31.16:8123'), 'ws://192.168.31.16:8123/api/websocket');
});

test('wsUrl：https → wss', () => {
  assert.equal(wsUrl('https://ha.example.com'), 'wss://ha.example.com/api/websocket');
});

test('instKey：同 sid/version 得到同键，键含版本号', () => {
  assert.equal(instKey('rstop', 3), 'rstop#v3');
  assert.equal(instKey('rstop', 3), instKey('rstop', 3));
});

test('instKey：不同版本不同键', () => {
  assert.notEqual(instKey('rstop', 1), instKey('rstop', 2));
});
