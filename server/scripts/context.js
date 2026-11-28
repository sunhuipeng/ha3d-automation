'use strict';
/* Node-RED 风格的轻量上下文：global（跨脚本）与 local（脚本内）。
 * 影子与正式用不同命名空间隔离；runner 只经 IPC 读写，本模块负责落盘/锁/原子替换。 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DATA, ensureDataDir } = require('../config');
const { safeId } = require('./inst-key'); // id 校验唯一实现在 inst-key（防三处正则漂移）

const FILE = path.join(DATA, 'context.json');
let cache = null;
let writeChain = Promise.resolve();
/* ctx.global.watch 的变更源：只有 global 作用域、且值确实变化时发事件。
 * 事件同步发出（内存即真相，落盘异步）：{ scope, namespace, key, value, prev, writerSid }。 */
const changes = new EventEmitter();
changes.setMaxListeners(0); // 订阅者数量由执行器按实例管理，不受默认 10 个上限约束

function empty() {
  return {
    global: {
      production: {}, shadow: {},
      /* key -> writerSid：global 桶的写者身份（单写者约定的落地）。
       * 与值分表存（不包 {v,w}）：值结构零变化、无"值恰好像包装对象"的歧义。 */
      writers: { production: {}, shadow: {} },
    },
    local: {},
  };
}

function readAll() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = {
      global: {
        production: raw.global && raw.global.production && typeof raw.global.production === 'object' ? raw.global.production : {},
        shadow: raw.global && raw.global.shadow && typeof raw.global.shadow === 'object' ? raw.global.shadow : {},
        /* 旧数据没有 writers 表：就地补空结构（懒迁移，键在首次 set 后自动盖章） */
        writers: raw.global && raw.global.writers && typeof raw.global.writers === 'object' ? raw.global.writers : { production: {}, shadow: {} },
      },
      local: raw.local && typeof raw.local === 'object' ? raw.local : {},
    };
    for (const ns of ['production', 'shadow']) {
      if (!cache.global.writers[ns] || typeof cache.global.writers[ns] !== 'object') cache.global.writers[ns] = {};
    }
  } catch (e) {
    cache = empty();
  }
  return cache;
}

function all(scope) {
  if (scope !== 'global' && scope !== 'local') throw new Error('未知上下文作用域：' + scope);
  const data = readAll();
  if (scope === 'global') return data.global;
  return data.local;
}

function namespace(scope, scriptId, dryRun) {
  if (scope === 'global') return dryRun ? 'shadow' : 'production';
  return String(scriptId || 'unknown') + ':' + (dryRun ? 'shadow' : 'production');
}

function validKey(key) {
  const s = String(key == null ? '' : key);
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(s) ? s : null;
}

/* 取命名空间桶（只读用途；set 直接写 map[ns]，不走这里） */
function bucket(scope, scriptId, dryRun) {
  const map = all(scope);
  const ns = namespace(scope, scriptId, dryRun);
  return map[ns] || {};
}

function clone(v) {
  if (v == null) return v;
  return JSON.parse(JSON.stringify(v));
}

function get(scope, scriptId, key, dryRun, fallback) {
  const k = validKey(key);
  if (!k) throw new Error('上下文 key 非法（仅允许字母数字 _ . : -，1–128 位）');
  const b = bucket(scope, scriptId, dryRun);
  return Object.prototype.hasOwnProperty.call(b, k) ? clone(b[k]) : clone(fallback);
}

function set(scope, scriptId, key, value, dryRun) {
  const k = validKey(key);
  if (!k) throw new Error('上下文 key 非法（仅允许字母数字 _ . : -，1–128 位）');
  let copy;
  try { copy = clone(value); } catch (e) { throw new Error('上下文值必须可 JSON 序列化'); }
  const data = readAll();
  const map = all(scope);
  const ns = namespace(scope, scriptId, dryRun);
  if (!map[ns]) map[ns] = {};
  const had = Object.prototype.hasOwnProperty.call(map[ns], k);
  const prev = had ? clone(map[ns][k]) : null; // 首次写入用 null 表示"没有旧值"，IPC 后语义稳定
  map[ns][k] = copy;
  /* 值未变不发：同值重复 set 是脚本常见写法（防抖/心跳），不能刷屏订阅者。
   * 用序列化比较覆盖对象/数组；undefined → null 这类差异按真实值比较。 */
  if (scope === 'global') {
    /* 单写者约定落地：写者身份落盘 + 被其他脚本接管时告警（软约束，不拒绝——
     * 避免误伤一次性接管场景；约定漂移靠告警暴露，由人裁决）。 */
    const writers = data.global.writers[ns] || (data.global.writers[ns] = {});
    const prevW = writers[k] || null;
    const sid = String(scriptId || '');
    if (prevW && prevW !== sid) {
      process.emitWarning(`全局上下文单写者约定告警：key=${k} 前写者=${prevW} 本次写入=${sid}`);
    }
    writers[k] = sid;
    /* 值未变不发：同值重复 set 是脚本常见写法（防抖/心跳），不能刷屏订阅者。 */
    if (!had || JSON.stringify(prev) !== JSON.stringify(copy)) {
      changes.emit('change', { scope, namespace: ns, key: k, value: clone(copy), prev, writerSid: sid });
    }
  }

  writeChain = writeChain.then(() => {
    ensureDataDir();
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, FILE);
  }).catch((e) => {
    // 保留写链，避免一次失败后所有后续写都被跳过
    emitError(e);
    return undefined;
  });
  return writeChain;
}

function emitError(e) {
  if (process && typeof process.emitWarning === 'function') process.emitWarning('上下文落盘失败：' + (e && e.message || e));
}

/* 只读快照，供 MCP / 调试；默认按当前模式返回对应命名空间 */
function snapshot(dryRun) {
  const data = readAll();
  const nsGlobal = dryRun ? 'shadow' : 'production';
  const local = {};
  for (const [ns, value] of Object.entries(data.local)) {
    if (ns.endsWith(':' + nsGlobal)) local[ns] = clone(value);
  }
  return {
    global: clone(data.global[nsGlobal] || {}),
    writers: clone(data.global.writers[nsGlobal] || {}), // key -> 写者脚本 id（单写者约定可观测）
    local,
  };
}

/* key 的写者身份（global 专用；执行器 contextGet withMeta / 写者状态派发共用） */
function writerOf(key, dryRun) {
  const k = validKey(key);
  if (!k) return null;
  const data = readAll();
  const ns = dryRun ? 'shadow' : 'production';
  return data.global.writers[ns][k] || null;
}

/* 某写者脚本写过的全部 global key（写者停止/重启时派发 writerState 用） */
function keysByWriter(ns, sid) {
  const data = readAll();
  const writers = data.global.writers[ns] || {};
  const s = String(sid || '');
  return Object.keys(writers).filter((k) => writers[k] === s);
}

/* 删除脚本时清理其 ctx.local 命名空间（<sid>:shadow / <sid>:production）。
 * ctx.global 是跨脚本共享命名空间、键无法归属到单个脚本，这里不动；
 * 若被删脚本写过 global 键且已无消费者，由使用者自行确认清理。 */
function removeScript(id) {
  const sid = safeId(id);
  if (!sid) throw new Error('脚本 id 非法');
  const data = readAll();
  for (const ns of [sid + ':shadow', sid + ':production']) delete data.local[ns];
  writeChain = writeChain.then(() => {
    ensureDataDir();
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, FILE);
  }).catch((e) => {
    emitError(e);
    return undefined;
  });
  return writeChain;
}

/* 订阅 global 变更（执行器用）：返回取消订阅函数。 */
function onChange(cb) {
  changes.on('change', cb);
  return () => changes.off('change', cb);
}

module.exports = { get, set, snapshot, removeScript, onChange, validKey, writerOf, keysByWriter };
