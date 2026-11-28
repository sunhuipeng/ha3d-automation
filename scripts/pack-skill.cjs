#!/usr/bin/env node
/**
 * 纯 Node 打包目录为 zip —— 构建期替代镜像里的 `apk add zip` + `zip -qr`
 *
 * 用法：
 *   node scripts/pack-skill.cjs [srcDir=skill] [outFile=skill.zip]
 *
 * 为什么不用系统 zip：
 *   - apk add 需要联网到 Alpine 官方源，国内经常几十秒，且与 COPY skill 同层，skill 一改就重下；
 *   - 只用 Node 内置 zlib（deflateRawSync / crc32），既不装 apk 包也不加 npm 依赖。
 *
 * 行为与旧命令等价（`cd skill && zip -qr skill.zip . -x ".cache/*"`）：
 *   - 条目相对 srcDir 根，不套一层目录（解压即得 skill 内容）；
 *   - 跳过 .cache/、.git/、.DS_Store；
 *   - 文件名用 '/' 分隔并置 UTF-8 标志位（bit 11），中文名不乱码；
 *   - 条目按路径排序，同样的输入产出同样的字节序，便于比对。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION_NEEDED = 20;          // 2.0：deflate / 目录条目都够用
const VERSION_MADE_BY = 0x0314;     // (3=Unix) << 8 | 20，让 unzip 认 externalAttrs 的 unix 权限位

const SKIP_NAMES = new Set(['.cache', '.fixtures', '.scripts', '.work', '.notes', '.git', '.DS_Store']);

/* ---------- crc32 ---------- */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0; // Node >= 20.15
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------- DOS 时间 ---------- */
function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, day: day & 0xffff };
}

/* ---------- 收集条目 ---------- */
function collect(root) {
  const entries = [];
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error(`不是目录：${root}`);

  (function walk(dir, rel) {
    const list = fs.readdirSync(dir, { withFileTypes: true })
      .filter((ent) => !SKIP_NAMES.has(ent.name))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const ent of list) {
      const abs = path.join(dir, ent.name);
      const name = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) continue;          // 软链跳过，避免跨目录/环
      if (ent.isDirectory()) {
        entries.push({ name, dir: true, abs });
        walk(abs, name);
      } else if (ent.isFile()) {
        entries.push({ name, dir: false, abs });
      }
    }
  })(root, '');

  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/* ---------- 写 zip ---------- */
function makeZip(root) {
  const entries = collect(root);
  const locals = [];
  const centrals = [];
  let offset = 0;
  let rawBytes = 0;
  let fileCount = 0;
  let dirCount = 0;

  for (const item of entries) {
    const nameBuf = Buffer.from(item.name + (item.dir ? '/' : ''), 'utf8');
    const data = item.dir ? Buffer.alloc(0) : fs.readFileSync(item.abs);
    const mtime = fs.statSync(item.abs).mtime;
    const { time, day } = dosDateTime(mtime);

    let method = METHOD_STORE;
    let payload = data;
    if (data.length > 0) {
      const deflated = zlib.deflateRawSync(data, { level: 9 });
      if (deflated.length < data.length) {
        method = METHOD_DEFLATE;
        payload = deflated;
      }
    }

    const crc = item.dir ? 0 : crc32(data);
    const attrs = item.dir ? ((0o040755 << 16) | 0x10) >>> 0 : ((0o100644 << 16) | 0) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);                    // extraLen

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);                  // extraLen
    central.writeUInt16LE(0, 32);                  // commentLen
    central.writeUInt16LE(0, 34);                  // diskStart
    central.writeUInt16LE(0, 36);                  // internalAttrs
    central.writeUInt32LE(attrs, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuf, payload);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
    rawBytes += data.length;
    item.dir ? dirCount++ : fileCount++;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);                        // diskNum
  eocd.writeUInt16LE(0, 6);                        // cdStartDisk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);                       // commentLen

  return {
    buffer: Buffer.concat([...locals, centralBuf, eocd]),
    fileCount,
    dirCount,
    rawBytes,
  };
}

/* ---------- CLI ---------- */
function main(argv) {
  const src = path.resolve(argv[0] || 'skill');
  const out = path.resolve(argv[1] || 'skill.zip');
  const { buffer, fileCount, dirCount, rawBytes } = makeZip(src);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buffer);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`[pack-skill] ${src} → ${out}`);
  console.log(`[pack-skill] ${fileCount} 文件 / ${dirCount} 目录，原始 ${kb(rawBytes)} → zip ${kb(buffer.length)}`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`[pack-skill] 失败：${err.message}`);
    process.exit(1);
  }
}

module.exports = { makeZip };
