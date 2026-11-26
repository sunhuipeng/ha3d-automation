'use strict';
/* 锁住“状态存放分层”规则，防止以后又把本项目私有状态写进 HA helper 或滥用全局上下文。
 * 判据（CONTRACT.md §6）：
 *   只有本脚本读且重启可重算 → 内存；只有本脚本读但需复原 → ctx.local；
 *   另一个脚本要读写 → ctx.global；人要改/人要看的配置 → HA 实体。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(__dirname, './fixtures', f), 'utf8');
const avoid = read('water-heater-avoid.dryrun.js');
const schedule = read('water-heater-schedule.dryrun.js');

const keysOf = (src, kind, op) =>
  [...src.matchAll(new RegExp(`ctx\\.${kind}\\.${op}\\(\\s*'([^']+)'`, 'g'))].map((m) => m[1]);
const uniq = (a) => [...new Set(a)];
const subset = (actual, allowed, msg) => {
  const extra = uniq(actual).filter((k) => !allowed.includes(k));
  assert.deepEqual(extra, [], `${msg}：出现未预期键 ${extra.join(', ')}`);
};

test('规避脚本不写任何本项目私有的 HA helper', () => {
  assert.ok(!avoid.includes('input_boolean.re_shui_qi_gui_bi_zhong'), '不应再引用规避标志实体');
  assert.ok(!/callService\(\s*'input_boolean'/.test(avoid), '规避脚本不应调用 input_boolean 服务');
});

test('规避脚本的全局上下文只保留跨脚本契约键', () => {
  const allowed = ['waterHeater.avoiding', 'waterHeater.pendingStart'];
  subset(keysOf(avoid, 'global', 'set'), allowed, 'global.set');
  subset(keysOf(avoid, 'global', 'get'), allowed, 'global.get');
});

test('规避脚本的计时器只在内存，不占 ctx.local', () => {
  assert.ok(!/ctx\.local\./.test(avoid), 'highSince / allClearSince 属于秒级计时，应留在内存');
});

test('定时脚本只把 pendingStart 写给别的脚本，只读 avoiding', () => {
  subset(keysOf(schedule, 'global', 'set'), ['waterHeater.pendingStart'], 'global.set');
  subset(keysOf(schedule, 'global', 'get'), ['waterHeater.avoiding'], 'global.get');
});

test('当日触发标记属于脚本内状态，不得占用全局命名空间', () => {
  assert.ok(!avoid.includes('scheduleLastDate'), '规避脚本不应出现 scheduleLastDate');
  assert.ok(!schedule.includes('scheduleLastDate'), '定时脚本的当日标记应放 ctx.local');
  assert.ok(keysOf(schedule, 'local', 'set').includes('schedule.lastDate'), '当日标记应写 ctx.local');
});
