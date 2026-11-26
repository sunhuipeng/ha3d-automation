'use strict';
/* 运行意图清单：持久化「哪些实例在运行 + 各自运行哪个版本」。
 *
 * 为什么需要它：executor 的 running Map 是纯内存，进程重启即丢失；meta.json 已不再存
 * status（2026-11-26 收窄），运行状态由 executor 内存判定。这里单独落一份「重启恢复」真相源。
 *
 * 存储格式（v2，按"脚本 + 版本"登记，支持正式版与影子版同时运行）：
 *   { version: 2, entries: { "sid#v4": { scriptId, version, startedAt } } }
 *
 * 兼容 v1（{ entries: { sid: { version, startedAt } } }）：read() 时原地归一成 v2 形状，
 * 下次写入即完成迁移。因此老数据的"重启恢复"不会因为升级而丢失。
 *
 * 约定：
 *  - executor.start() 成功 → mark(sid, version)；start 失败绝不写入。
 *  - 任意结束路径（stop / done / timeout / exit 不重启）→ clear(sid, version)；
 *    stop(sid) 不带版本 → 清该脚本全部实例。
 *  - 进程启动 → load() 读出清单，交给 executor.restore() 逐个版本重新拉起。
 *  - 原子写：先写 .tmp 再 rename，避免重启正好撞上写一半产生半截 JSON。
 */
const fs = require('fs');
const path = require('path');
const { DATA, ensureDataDir } = require('../config');
const { instKey, parseKey, safeId } = require('./inst-key');

const STATE_FILE = path.join(DATA, 'runtime', 'desired-running.json');
const TMP_FILE = STATE_FILE + '.tmp';

/* 键格式与 executor 共用 inst-key.js（审计 F4：此前两处独立实现，改动一侧会静默断恢复链） */
const entryKey = instKey;

function read() {
  let obj;
  try { obj = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
  const raw = obj && typeof obj === 'object' && obj.entries && typeof obj.entries === 'object' && !Array.isArray(obj.entries)
    ? obj.entries : {};
  const entries = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!val || typeof val !== 'object') continue;
    const v = Number(val.version);
    if (!Number.isInteger(v) || v < 1) continue;
    /* v2 键形如 sid#v3；v1 键就是 sid —— 用值里的 scriptId/键名补齐 */
    const sid = val.scriptId || parseKey(key).sid;
    if (!safeId(sid)) continue;
    entries[entryKey(sid, v)] = { scriptId: sid, version: v, startedAt: Number(val.startedAt) || Date.now() };
  }
  return entries;
}

function write(entries) {
  ensureDataDir();
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(TMP_FILE, JSON.stringify({ version: 2, entries }, null, 2) + '\n');
  fs.renameSync(TMP_FILE, STATE_FILE);
}

/* 记录一条运行意图。version 必须是正整数，否则忽略。 */
function mark(id, version, startedAt) {
  const sid = String(id || '');
  const v = Number(version);
  /* 与 store.safeId 同口径，防止 ../ 之类的 id 污染清单键 */
  if (!safeId(sid) || !Number.isInteger(v) || v < 1) return;
  const entries = read();
  entries[entryKey(sid, v)] = { scriptId: sid, version: v, startedAt: Number(startedAt) || Date.now() };
  write(entries);
}

/* 清除运行意图：给 version 只清该版本，不给则清该脚本全部实例。 */
function clear(id, version) {
  const sid = String(id || '');
  const entries = read();
  let changed = false;
  if (version == null) {
    for (const [key, val] of Object.entries(entries)) {
      if (val.scriptId === sid) { delete entries[key]; changed = true; }
    }
  } else {
    const key = entryKey(sid, version);
    if (key in entries) { delete entries[key]; changed = true; }
  }
  if (changed) write(entries);
}

/* has(id) 判断该脚本是否有任一实例；has(id, version) 判断具体版本。 */
function has(id, version) {
  const sid = String(id || '');
  const entries = read();
  if (version != null) return entryKey(sid, version) in entries;
  return Object.values(entries).some((e) => e.scriptId === sid);
}

module.exports = { entryKey, read, mark, clear, has };
