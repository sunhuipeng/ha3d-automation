/**
 * scripts/pack-skill.cjs —— 构建期打 zip 的纯 Node 实现
 *
 * 钉三件事：
 *   1. 条目内容能被标准方式解出来（deflate 往返 + crc 校验 + 偏移自洽）；
 *   2. .cache / .DS_Store / .git 必须排除（与旧 `zip -x ".cache/*"` 口径一致）；
 *   3. 空目录/空文件、中文名、二进制不被破坏。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { makeZip } = require('../scripts/pack-skill.cjs');

/* 最小 zip 读取器：走中央目录 → 按偏移解 local header → 取出原始内容 */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'EOCD 存在');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  assert.equal(cdOffset + cdSize, eocd, '中央目录长度与 EOCD 偏移自洽');

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, '中央目录签名');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, `local header 签名：${name}`);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const payload = buf.subarray(dataStart, dataStart + compSize);
    let body = Buffer.alloc(0);
    if (rawSize > 0) {
      body = method === 8 ? zlib.inflateRawSync(payload) : Buffer.from(payload);
    }
    assert.equal(body.length, rawSize, `解压长度一致：${name}`);
    assert.equal(zlib.crc32(body) >>> 0, crc >>> 0, `crc 校验：${name}`);

    entries.push({ name, size: rawSize, body });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  assert.equal(p, eocd, '中央目录读完后正好到 EOCD');
  return entries;
}

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-skill-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

test('pack-skill：条目可解压还原，且排除 .cache/.DS_Store', () => {
  const root = makeTree({
    'SKILL.md': '# skill\n正文含中文',
    'references/api.md': 'api',
    'templates/empty.txt': '',
    'bin/blob.dat': Buffer.from([0, 1, 2, 255, 254, 0, 42]),
    '.cache/s1/script.js': 'should be excluded',
    '.DS_Store': 'junk',
  });

  const { buffer, fileCount } = makeZip(root);
  const entries = readZip(buffer);
  const names = entries.map((e) => e.name);

  assert.equal(fileCount, 4, '只统计真实文件');
  assert.ok(names.includes('SKILL.md'));
  assert.ok(names.includes('references/api.md'));
  assert.ok(names.includes('templates/empty.txt'));
  assert.ok(names.includes('bin/blob.dat'));
  assert.ok(!names.some((n) => n.includes('.cache')), '.cache 被排除');
  assert.ok(!names.some((n) => n.includes('.DS_Store')), '.DS_Store 被排除');

  const byName = Object.fromEntries(entries.map((e) => [e.name, e.body]));
  assert.equal(byName['SKILL.md'].toString('utf8'), '# skill\n正文含中文');
  assert.equal(byName['templates/empty.txt'].length, 0, '空文件保留且长度为 0');
  assert.deepEqual([...byName['bin/blob.dat']], [0, 1, 2, 255, 254, 0, 42], '二进制原样还原');

  fs.rmSync(root, { recursive: true, force: true });
});

test('pack-skill：同一输入两次打包字节一致（条目排序稳定）', () => {
  const root = makeTree({ 'b.txt': 'b', 'a/c.txt': 'c', 'a.txt': 'a' });
  const first = makeZip(root).buffer;
  const second = makeZip(root).buffer;
  assert.equal(first.equals(second), true);
  const names = readZip(first).map((e) => e.name);
  // 目录条目按去掉尾斜杠的原名参与排序，所以 a/ 排在 a.txt 之前
  assert.deepEqual(names, ['a/', 'a.txt', 'a/c.txt', 'b.txt']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('pack-skill CLI：默认把目录打成 zip 文件', () => {
  const root = makeTree({ 'SKILL.md': 'x' });
  const out = path.join(root, '..', `${path.basename(root)}-out.zip`);
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, [path.join(process.cwd(), 'scripts/pack-skill.cjs'), root, out], { stdio: 'pipe' });
  const buf = fs.readFileSync(out);
  assert.equal(readZip(buf)[0].name, 'SKILL.md');
  fs.rmSync(out, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});
