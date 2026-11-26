#!/usr/bin/env node
/* 脚本缓存同步器（ha3d-automation skill）
 * 把服务端所有脚本的最新版本拉到本地 skill/.cache/，供 AI 快速解析 / 阅读 / 做冲突分析。
 *
 * 用法:
 *   node skill/tools/sync-cache.cjs            # 增量同步（只拉变化的最新版本）
 *   node skill/tools/sync-cache.cjs --all      # 连同历史版本一起缓存
 *   node skill/tools/sync-cache.cjs --force    # 忽略缓存，全量重拉
 *   node skill/tools/sync-cache.cjs --quiet    # 仅在有更新时输出
 *
 * 环境变量: HA3D_BASE（默认 http://127.0.0.1:8100）
 * 退出码: 0 成功 / 1 服务不可达或请求失败
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = process.env.HA3D_BASE || 'http://127.0.0.1:8100';
const CACHE_DIR = path.resolve(__dirname, '..', '.cache');
const INDEX_JSON = path.join(CACHE_DIR, '_index.json');
const INDEX_MD = path.join(CACHE_DIR, '_index.md');

const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const FORCE = argv.includes('--force');
const QUIET = argv.includes('--quiet');

/* 常用 HA 域，用于从脚本源码里抽取实体引用（做冲突/合并分析用） */
const DOMAINS = 'light|switch|sensor|binary_sensor|input_number|input_boolean|input_select|input_text|'
  + 'input_datetime|climate|fan|cover|media_player|vacuum|person|device_tracker|automation|script|'
  + 'number|select|text|button|counter|timer|weather|sun|zone';
const ENTITY_RE = new RegExp(`\\b((?:${DOMAINS})\\.[a-z0-9_]+)\\b`, 'g');

function request(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + pathname, { timeout: 8000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`${pathname} → HTTP ${res.statusCode} ${body.slice(0, 120)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`${pathname} 返回非 JSON`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${pathname} 请求超时`)));
    req.on('error', reject);
  });
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function extractEntities(src) {
  const set = new Set();
  for (const m of String(src).matchAll(ENTITY_RE)) set.add(m[1]);
  return [...set].sort();
}

function prune(dir, keep) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('_')) continue;
    if (!keep.has(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

(async () => {
  let health;
  try {
    health = await request('/api/health');
  } catch (e) {
    console.error(`[cache] 服务不可达 ${BASE}：${e.message}`);
    console.error('[cache] 先启动服务：(cd D:/Workbuddy/home/ha3d-automation && npm start)');
    process.exit(1);
  }

  const list = await request('/api/scripts');
  const index = { syncedAt: new Date().toISOString(), base: BASE, scripts: {} };
  let updated = 0;
  let skipped = 0;

  for (const s of list) {
    const id = s.id;
    const latest = s.latestVersion;
    if (latest == null) continue;

    /* 版本清单总是拉：影子版本可原地修改（版本号不变、内容会变），
     * 只靠"版本目录已存在"判断会缓存到过期源码。用 sha256 + updatedAt 双重比对。 */
    const detail = await request(`/api/script/${id}/versions`);
    const verList = (detail.versions || []).slice().sort((a, b) => a.version - b.version);
    const byVersion = new Map(verList.map((v) => [v.version, v]));
    const versions = ALL ? verList.map((v) => v.version) : [latest];
    if (!versions.length) continue;

    const cachedVersions = [];
    let changed = false;
    for (const v of versions) {
      const dir = path.join(CACHE_DIR, id, `v${v}`);
      const scriptFile = path.join(dir, 'script.js');
      const cachedMeta = readJson(path.join(dir, 'meta.json'), {});
      const remote = byVersion.get(v) || {};
      /* 只用 sha256 判内容变化：updatedAt 只在影子提交/发布时写入，语义是"内容变化时间"，
       * 但 sha256 已是内容级的精确判据，updatedAt 比对是冗余且可能因发布动作误判。 */
      const unchanged = !FORCE && fs.existsSync(scriptFile)
        && cachedMeta.sha256 && remote.sha256 && cachedMeta.sha256 === remote.sha256;
      if (unchanged) { cachedVersions.push(v); continue; }

      const rec = await request(`/api/script/${id}?version=${v}`);
      writeAtomic(scriptFile, rec.script || '');
      writeAtomic(path.join(dir, 'flow.json'), JSON.stringify(rec.flow || { nodes: [], edges: [] }, null, 2) + '\n');
      writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(rec.meta || {}, null, 2) + '\n');
      cachedVersions.push(v);
      changed = true;
    }

    /* 清理该脚本缓存里不在本次同步清单中的过期版本目录：
     * 旧 --all 缓存过 v1..v4、现在 latest=v5 时 v1..v4 若不清，陈旧源码会误导 AI 读到旧内容 */
    prune(path.join(CACHE_DIR, id), new Set(versions.map((v) => `v${v}`)));

    const latestRec = readJson(path.join(CACHE_DIR, id, `v${latest}`, 'meta.json'), {});
    let latestSrc = '';
    try { latestSrc = fs.readFileSync(path.join(CACHE_DIR, id, `v${latest}`, 'script.js'), 'utf8'); } catch (e) { /* 忽略 */ }

    index.scripts[id] = {
      id,
      name: s.name,
      status: s.status,
      latestVersion: latest,
      cachedVersions: cachedVersions.sort((a, b) => a - b),
      shadowVersion: s.shadowVersion ?? null,
      shadowRevision: s.shadowRevision ?? 0,
      productionVersion: s.productionVersion ?? null,
      runningVersion: s.runningVersion ?? null,
      kind: s.kind || 'automation',
      description: s.description || null,
      sha256: latestRec.sha256 || null,
      entities: extractEntities(latestSrc),
      cachedAt: new Date().toISOString(),
    };
    if (changed) updated++; else skipped++;
  }

  /* 清理已删除脚本的缓存 */
  prune(CACHE_DIR, new Set(list.map((s) => s.id)));

  writeAtomic(INDEX_JSON, JSON.stringify(index, null, 2) + '\n');

  /* 人/AI 双读的索引表（影子 revision 反映"改过几次"，运行版本反映"真正在跑哪个"） */
  const rows = Object.values(index.scripts).map((s) => {
    const ents = s.entities.length ? s.entities.slice(0, 3).join(', ') + (s.entities.length > 3 ? ` …(${s.entities.length})` : '') : '-';
    const ch = s.productionVersion ? `正式 v${s.productionVersion}` : '—';
    const sh = s.shadowVersion ? `v${s.shadowVersion}（改号 ${s.shadowRevision}）` : '—';
    const run = s.runningVersion ? `v${s.runningVersion}` : '—';
    return `| ${s.id} | ${s.name} | ${ch} | ${sh} | ${run} | ${s.status} | ${s.entities.length} | ${ents} |`;
  });
  writeAtomic(INDEX_MD, [
    '# 脚本缓存索引',
    '',
    `同步时间：${index.syncedAt}　服务：${BASE}　脚本数：${list.length}`,
    '',
    '版本模型：影子是**可反复修改的工作副本**（版本号不变、revision 递增）；正式版不可变；归档分 published（曾上线，回滚候选）/ discarded（试错废弃）。',
    '',
    '| scriptId | 名称 | 正式版本 | 影子版本 | 运行中 | 状态 | 实体数 | 实体（前 3） |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '完整实体清单见 `_index.json` 的 `scripts.<id>.entities`；源码在 `<id>/v<n>/script.js`。',
    '影子版本内容会变，判断"是否最新"请比对 `_index.json` 的 sha256，不要只看版本号。',
    '',
  ].join('\n'));

  if (!QUIET || updated) {
    console.log(`[cache] ${CACHE_DIR}`);
    console.log(`[cache] 脚本 ${list.length} 个：更新 ${updated}，跳过 ${skipped}（已是最新）`);
    for (const s of Object.values(index.scripts)) {
      console.log(`  - ${s.id} v${s.latestVersion} ${s.status} 实体${s.entities.length}个`);
    }
    console.log(`[cache] 索引：${path.relative(process.cwd(), INDEX_MD)}`);
  }
})().catch((e) => {
  console.error('[cache] 同步失败：' + (e && e.message ? e.message : e));
  process.exit(1);
});
