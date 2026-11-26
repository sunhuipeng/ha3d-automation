'use strict';
/* 提交影子后前端要自动切到新版本详情：广播需带 scriptId/version。
 * 这里锁定 executor.broadcastRefresh 的载荷形状（ws-hub 是单例，临时替换 broadcast 捕获即可）。 */
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const hub = require('../server/lib/ws-hub');
const executor = require('../server/scripts/executor');

function capture(fn) {
  const orig = hub.broadcast;
  const seen = [];
  hub.broadcast = (payload) => { seen.push({ ...payload }); return 0; };
  try { fn(); } finally { hub.broadcast = orig; }
  return seen;
}

test('broadcastRefresh 不带 extra 时保持原行为（前端重拉当前打开版本）', () => {
  const seen = capture(() => executor.broadcastRefresh(['scripts', 'script']));
  assert.deepEqual(seen.map((p) => p.what), ['scripts', 'script']);
  for (const p of seen) {
    assert.equal(p.type, 'refresh');
    assert.equal(p.scriptId, undefined);
    assert.equal(p.version, undefined);
    assert.equal(typeof p.ts, 'number');
  }
});

test('提交/回滚广播带目标版本，前端可切到刚提交的影子版本', () => {
  const seen = capture(() => executor.broadcastRefresh(['scripts', 'script'], { scriptId: 'audr76je', version: 2, ts: 1 }));
  assert.deepEqual(seen.map((p) => p.what), ['scripts', 'script']);
  for (const p of seen) {
    assert.equal(p.scriptId, 'audr76je');
    assert.equal(p.version, 2);
    assert.notEqual(p.ts, 1, 'ts 由广播时刻生成，不被调用方覆盖');
  }
});
