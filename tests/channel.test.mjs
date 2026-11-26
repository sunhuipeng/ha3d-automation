'use strict';
/* 版本角色模型单测：影子/正式各至多一个、发布替换、清理、老数据迁移。
 * 关键手法：在 require store 之前把 config.DATA 指向临时目录，避免碰真实 data。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-store-'));
const config = require('../server/config');
config.DATA = tmpRoot; // 必须在 require store 之前覆盖，store 顶部据此算 SCRIPTS_DIR
const store = require('../server/scripts/store');

const FLOW = { version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] };
const SCRIPT = 'ctx.log("info","unit");';

function submit(id, extra = {}) {
  return store.submit(id, { name: id, script: SCRIPT, flow: FLOW, kind: 'automation', ...extra });
}

test('新提交的版本默认是 shadow，运行身份由 channel 派生', () => {
  const rec = submit('bot');
  assert.equal(rec.meta.channel, 'shadow');
  assert.equal('dryRun' in rec.meta, false, 'dryRun 落盘字段已退役');
  assert.equal(rec.version, 1);
});

test('影子可原地反复修改：版本号不变、revision 递增，始终只有一个 shadow', () => {
  const v1 = submit('bot2', { script: 'ctx.log("info","a");' });
  const again = submit('bot2', { script: 'ctx.log("info","b");' });
  assert.equal(again.version, 1, '修改影子不新增版本号');
  assert.equal(again.overwritten, true);
  assert.equal(again.meta.revision, 2, '改版次数递增');
  assert.equal(again.meta.channel, 'shadow');
  assert.deepEqual(store.listVersions('bot2'), [1], '磁盘上仍只有一个版本目录');
  assert.notEqual(again.meta.sha256, v1.meta.sha256, 'sha256 随内容更新');
  assert.equal(store.versionOfChannel('bot2', 'shadow'), 1);

  const forced = submit('bot2', { newVersion: true });
  assert.equal(forced.version, 2, '显式 newVersion 才分配新版本号');
  assert.equal(forced.meta.revision, 1, '新版本从改版次数 1 起算');
  assert.equal(store.getMeta('bot2', 1).channel, 'archive', '旧影子被新影子归档');
});

test('发布影子为正式：channel 转 production，无旧正式时 previousProduction=null', () => {
  submit('bot3');
  const r = store.publish('bot3');
  assert.equal(r.version, 1);
  assert.equal(r.previousProduction, null);
  assert.equal(store.getMeta('bot3', 1).channel, 'production');
  assert.equal(store.versionOfChannel('bot3', 'production'), 1);
});

test('影子→发布→再提交影子→再发布：旧正式自动归档，各角色始终唯一', () => {
  submit('bot4');                       // v1 shadow
  store.publish('bot4');                // v1 production
  const s2 = submit('bot4');            // v2 shadow（v1 仍 production）
  assert.equal(s2.version, 2);
  assert.equal(store.versionOfChannel('bot4', 'production'), 1);
  assert.equal(store.versionOfChannel('bot4', 'shadow'), 2);
  const r = store.publish('bot4');      // v2 production，v1 归档
  assert.equal(r.version, 2);
  assert.equal(r.previousProduction, 1);
  assert.equal(store.getMeta('bot4', 1).channel, 'archive');
  assert.equal(store.getMeta('bot4', 2).channel, 'production');
  const chans = store.detailedVersions('bot4').map((x) => x.channel);
  assert.equal(chans.filter((c) => c === 'shadow').length, 0);
  assert.equal(chans.filter((c) => c === 'production').length, 1);
});

test('只能发布影子版本，正式/归档版本发布会被拒绝', () => {
  submit('bot5');
  store.publish('bot5'); // v1 正式
  assert.throws(() => store.publish('bot5', 1), /只能发布影子版本/);
});

test('清理版本：只允许删归档版本（正式/影子不可删），删除后不影响其他版本', () => {
  submit('bot6'); store.publish('bot6');      // v1 正式
  submit('bot6');                             // v2 影子
  assert.throws(() => store.removeVersion('bot6', 1), /正式版本不可删除/);
  assert.throws(() => store.removeVersion('bot6', 2), /影子版本是工作副本/);
  store.publish('bot6', 2);                   // v2 正式，v1 转归档
  assert.equal(store.getMeta('bot6', 1).channel, 'archive');
  store.removeVersion('bot6', 1);
  assert.deepEqual(store.listVersions('bot6'), [2]);
  assert.equal(store.versionOfChannel('bot6', 'production'), 2);
});

test('归档分级：曾上线的归档标 published，被新影子挤掉的标 discarded', () => {
  submit('bot8'); store.publish('bot8');      // v1 上线过
  submit('bot8');                             // v2 影子
  submit('bot8', { newVersion: true });       // v3 影子，v2 被挤掉 → discarded
  store.publish('bot8', 3);                   // v3 正式，v1 → 归档（published）
  const byV = new Map(store.detailedVersions('bot8').map((x) => [x.version, x]));
  assert.equal(byV.get(1).channel, 'archive');
  assert.equal(byV.get(1).archivedKind, 'published');
  assert.equal(byV.get(1).mutable, false, '归档不可改');
  assert.equal(byV.get(2).channel, 'archive');
  assert.equal(byV.get(2).archivedKind, 'discarded');
  assert.equal(byV.get(3).channel, 'production');
  assert.equal(byV.get(3).mutable, false, '正式版不可改');
});

test('回滚：读历史版本原文提交为新影子版本，通道不变、不自动上线', () => {
  submit('bot9', { script: 'ctx.log("info","orig");' });
  store.publish('bot9');                      // v1 正式（原文）
  submit('bot9', { script: 'ctx.log("info","changed");' }); // v2 影子
  store.publish('bot9', 2);                   // v2 正式，v1 归档
  const rb = store.rollback('bot9', 1);
  assert.equal(rb.version, 3, '回滚也是新版本号，版本号只增');
  assert.equal(rb.meta.channel, 'shadow', '回滚产物是影子，需显式发布');
  assert.equal(store.get('bot9', 3).script, store.get('bot9', 1).script, '内容与历史原文一致');
  assert.match(rb.meta.description, /回滚自 v1/);
  assert.throws(() => store.rollback('bot9', 3), /回滚源是当前影子版本/);
});

test('老数据迁移：多个无 channel 的影子版本只保留最新为 shadow，其余归档', () => {
  // 手工造两个老版本 meta（无 channel，dryRun=true）
  const dir1 = path.join(tmpRoot, 'scripts', 'legacy', 'v1');
  const dir2 = path.join(tmpRoot, 'scripts', 'legacy', 'v2');
  fs.mkdirSync(dir1, { recursive: true }); fs.mkdirSync(dir2, { recursive: true });
  for (const [dir, v] of [[dir1, 1], [dir2, 2]]) {
    fs.writeFileSync(path.join(dir, 'script.js'), SCRIPT);
    fs.writeFileSync(path.join(dir, 'flow.json'), JSON.stringify(FLOW));
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: 'legacy', version: v, dryRun: true, status: 'stopped' }));
  }
  const migrated = store.normalizeChannels('legacy');
  assert.equal(migrated, true);
  assert.equal(store.getMeta('legacy', 1).channel, 'archive');
  assert.equal(store.getMeta('legacy', 2).channel, 'shadow');
  assert.equal(store.versionOfChannel('legacy', 'shadow'), 2);
});

test('list 暴露 shadowVersion / productionVersion', () => {
  submit('bot7'); store.publish('bot7');
  const row = store.list().find((x) => x.id === 'bot7');
  assert.equal(row.productionVersion, 1);
  assert.equal(row.shadowVersion, null);
});
