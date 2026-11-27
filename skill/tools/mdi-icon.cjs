#!/usr/bin/env node
/* MDI 图标工具：搜索 / 验证存在 / 取图并适配 currentColor。
 *
 * 背景：脚本 icon 统一用 MDI（Material Design Icons）库（Home 平台前端已接入同一套，
 * 两端风格天然一致）。Agent 写脚本时凭印象猜图标 slug 容易猜错（如 lightning 实际叫
 * flash），本工具把「选名 → 验证存在 → 拉源码 → 补 fill="currentColor"」固化成一条命令。
 *
 * 用法（node >= 18，零依赖）：
 *   node mdi-icon.cjs search <关键词>          按关键词搜图标名（本地缓存清单，7 天 TTL）
 *   node mdi-icon.cjs check <名称> [<名称>...]  验证图标是否存在于 CDN（提交前必做）
 *   node mdi-icon.cjs get <名称>               取 SVG 并补 fill="currentColor"，输出到 stdout
 *
 * 名称接受 kebab-case，可带可不带 .svg 后缀与 mdi- 前缀。
 * CDN 主源 jsdelivr，镜像 unpkg（主源不通自动切）。
 * 退出码：0 成功；1 参数错误/全部失败；get/check 遇 404 时该名称计 MISS。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VERSION = '@mdi/svg@7';
const CDN_PRIMARY = (name) => `https://cdn.jsdelivr.net/npm/${VERSION}/svg/${name}.svg`;
const CDN_FALLBACK = (name) => `https://unpkg.com/${VERSION}/svg/${name}.svg`;
const LIST_PRIMARY = 'https://data.jsdelivr.com/v1/packages/npm/@mdi/svg@7.4.47';
const LIST_FALLBACK = 'https://data.jsdelivr.com/v1/packages/npm/@mdi/svg@7';
const LIST_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 清单缓存 7 天，过期重拉

const cacheDir = path.join(__dirname, '..', '.cache');
const listCacheFile = path.join(cacheDir, 'mdi-files.json');

function normalize(name) {
  return String(name || '').trim().toLowerCase().replace(/\.svg$/, '').replace(/^mdi-/, '');
}

async function fetchWithFallback(urlA, urlB, opts) {
  try {
    const r = await fetch(urlA, { ...opts, signal: AbortSignal.timeout(15000) });
    if (r.ok) return r;
    if (r.status !== 404 && urlB) return await fetchWithFallback(urlB, null, opts);
    return r;
  } catch (e) {
    if (!urlB) throw e;
    return await fetchWithFallback(urlB, null, opts);
  }
}

/* ---------- 全量清单（search 用）：jsdelivr 文件树 → 图标名数组，落 .cache ---------- */
async function loadIconList() {
  try {
    const cached = JSON.parse(fs.readFileSync(listCacheFile, 'utf8'));
    if (Date.now() - cached.fetchedAt < LIST_TTL_MS && Array.isArray(cached.names)) return cached.names;
  } catch { /* 无缓存/坏缓存，继续拉取 */ }

  const r = await fetchWithFallback(LIST_PRIMARY, LIST_FALLBACK);
  if (!r.ok) throw new Error(`拉取 MDI 文件清单失败：HTTP ${r.status}`);
  const data = await r.json();
  const names = [];
  const walk = (node) => {
    for (const f of node.files || []) {
      if (f.type === 'directory') walk(f);
      else if (f.name.endsWith('.svg') && node.name === 'svg') names.push(f.name.replace(/\.svg$/, ''));
    }
  };
  walk(data);
  if (!names.length) throw new Error('清单解析得到 0 个图标，响应格式可能已变化');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(listCacheFile, JSON.stringify({ fetchedAt: Date.now(), version: data.version, names }, null, 0));
  return names;
}

/* ---------- 子命令 ---------- */
async function cmdSearch(keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) throw new Error('用法：node mdi-icon.cjs search <关键词>');
  const names = await loadIconList();
  const hits = names.filter((n) => n.includes(kw));
  console.log(`MDI 共 ${names.length} 个图标，"${kw}" 命中 ${hits.length} 个：`);
  for (const n of hits.slice(0, 60)) console.log('  ' + n);
  if (hits.length > 60) console.log(`  …（其余 ${hits.length - 60} 个略，请换更精确的关键词）`);
  if (!hits.length) process.exitCode = 1;
}

async function cmdCheck(rawNames) {
  if (!rawNames.length) throw new Error('用法：node mdi-icon.cjs check <名称> [<名称>...]');
  let miss = 0;
  for (const raw of rawNames) {
    const name = normalize(raw);
    const r = await fetchWithFallback(CDN_PRIMARY(name), CDN_FALLBACK(name), { method: 'GET' });
    const ok = r.ok;
    console.log(`${ok ? 'OK  ' : 'MISS'} ${name}${ok ? '' : '（HTTP ' + r.status + '，名称不存在）'}`);
    if (!ok) miss++;
  }
  if (miss) process.exitCode = 1;
}

async function cmdGet(rawName) {
  const name = normalize(rawName);
  if (!name) throw new Error('用法：node mdi-icon.cjs get <名称>');
  const r = await fetchWithFallback(CDN_PRIMARY(name), CDN_FALLBACK(name));
  if (!r.ok) throw new Error(`图标不存在：${name}（HTTP ${r.status}）。先用 search 找正确名称。`);
  let svg = (await r.text()).trim();
  // 关键适配：MDI 原文无着色属性（默认黑，暗色主题不可见）——根节点补 fill="currentColor"
  if (!/<svg[^>]*\sfill=/i.test(svg)) svg = svg.replace(/<svg\b/i, '<svg fill="currentColor"');
  // 去掉 id 属性（提交无需，保持干净）
  svg = svg.replace(/\sid="[^"]*"/i, '');
  process.stdout.write(svg + '\n');
}

/* ---------- 入口 ---------- */
(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'search') await cmdSearch(rest[0]);
    else if (cmd === 'check') await cmdCheck(rest);
    else if (cmd === 'get') await cmdGet(rest[0]);
    else {
      console.log('用法：node mdi-icon.cjs <search|check|get> …\n'
        + '  search <关键词>            搜图标名（如 search boiler）\n'
        + '  check <名称>[ <名称>…]     验证图标存在（提交前必做）\n'
        + '  get <名称>                 取 SVG 并补 fill="currentColor"，输出到 stdout\n'
        + '示例：node mdi-icon.cjs get water-boiler > icons/m7orioe9.svg');
    }
  } catch (e) {
    console.error('错误：' + (e && e.message || e));
    process.exitCode = 1;
  }
})();
