#!/usr/bin/env node
/* 提交脚本（ha3d-automation skill）
 * 用法:
 *   node skill/tools/submit.cjs <scriptId> <name> <srcFile> <flowFile> [description]
 *   node skill/tools/submit.cjs <scriptId> <name> <srcFile> <flowFile> --new-version [description]
 *   node skill/tools/submit.cjs <scriptId> <name> <srcFile> <flowFile> --check   # 只校验不提交
 *   node skill/tools/submit.cjs <scriptId> <name> <srcFile> <flowFile> --icon <icon.svg> [description]
 *   node skill/tools/submit.cjs <scriptId> <name> <srcFile> --placeholder [description]
 *
 * **影子可反复修改**：默认行为是"覆盖当前影子版本"（版本号不变、revision+1），
 * 迭代改脚本不会消耗版本号；想另起一个候选版才加 --new-version。
 * 正式版/归档版内容不可改——要改正式内容必须提交影子再 publish。
 *
 * 规则：flow.json 必须依据 script.js 的真实逻辑绘制（节点 id = 脚本里的 nodeId）。
 * 提交前会做交叉校验：flow 里的节点在脚本中不存在 → 报错；脚本里的 nodeId 未被 flow 覆盖 → 警告。
 * 只想快速占位时显式加 --placeholder（会写入通用三节点模板，仅用于链路联通测试）。
 * 默认提交为 shadow（影子）版本，kind=automation（常驻）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const USAGE = `用法: node skill/tools/submit.cjs <scriptId> <name> <srcFile> <flowFile> [description]
      node skill/tools/submit.cjs <scriptId> <name> <srcFile> <flowFile> --new-version [description]
      node skill/tools/submit.cjs <scriptId> <name> <srcFile> <flowFile> --icon <icon.svg> [description]
      node skill/tools/submit.cjs <scriptId> <name> <srcFile> <flowFile> --check

--icon <icon.svg>：脚本图标（SVG 源文件，内容存入 meta.json.icon，前端列表/详情展示）。
  **新脚本首次提交必须提供**；后续迭代不传则继承上一版。
  绘制规范：viewBox="0 0 64 64"、线条 stroke="currentColor"（颜色随前端主题）、≤8KB，详见 skill/references/file-specs.md §icon。

      node skill/tools/submit.cjs <scriptId> <name> <srcFile> --placeholder [description]

默认覆盖当前影子版本（版本号不变，revision+1）；--new-version 才另开新版本号（回滚/分支试验用）。
flow.json 规范见 skill/references/file-specs.md：节点/边必须来自 script.js 的实际执行路径，
nodes[].id 与脚本里 ctx.write / ctx.log 的 nodeId 一一对应，默认不写 layout（前端自动布局）。
nodeId 是 ctx.write 的位置参数不可省略；画布只读，运行态按 nodeId 高亮（error 红/其余绿），改图只能改 flow.json 随版本提交。`;

function fail(msg) { console.error(msg); process.exit(1); }

function placeholderFlow(scriptId) {
  return {
    version: 1,
    scriptId,
    nodes: [
      { id: 'n_start', type: 'trigger', label: '启动 / 实体变化 / 定时器' },
      { id: 'n_eval', type: 'condition', label: '判据与阈值' },
      { id: 'n_act', type: 'action', label: '业务动作（ctx.write）' },
    ],
    edges: [{ from: 'n_start', to: 'n_eval' }, { from: 'n_eval', to: 'n_act' }],
  };
}

function checkFlowAgainstScript(flow, script) {
  const problems = [];
  const warns = [];
  if (!flow || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
    problems.push('flow.json 需要 nodes / edges 数组');
    return { problems, warns };
  }
  const ids = flow.nodes.map((n) => n && n.id).filter(Boolean);
  if (ids.length !== flow.nodes.length) problems.push('存在缺少 id 的节点');
  if (new Set(ids).size !== ids.length) problems.push('存在重复的节点 id');
  const nodeSet = new Set(ids);
  for (const e of flow.edges) {
    if (!e || !nodeSet.has(e.from) || !nodeSet.has(e.to)) problems.push(`边 ${JSON.stringify(e)} 引用了不存在的节点`);
  }
  const dynamicNodeId = /['"`]n_\s*['"`]\s*\+/.test(script); /* 形如 'n_' + key 的动态拼接 */
  const used = new Set([...String(script).matchAll(/['"`](n_[a-z0-9_]+)['"`]/gi)].map((m) => m[1]));
  for (const id of nodeSet) {
    if (!used.has(id)) {
      const msg = `flow 节点 ${id} 在 script.js 里没有对应 nodeId（ctx.log / ctx.write 未使用）`;
      if (dynamicNodeId) warns.push(msg + '（脚本存在动态 nodeId 拼接，可能是误报）');
      else problems.push(msg);
    }
  }
  for (const id of used) if (!nodeSet.has(id)) warns.push(`脚本使用了 nodeId ${id}，但 flow.json 里没有该节点（日志将无法归组到节点）`);
  if (flow.nodes.some((n) => n && n.layout)) warns.push('flow.json 含 layout 字段：默认应省略（前端 dagre 自动布局），除非确实要固定坐标');
  if (flow.nodes.length < 2) warns.push('flow 节点少于 2 个，画布几乎无信息量');
  return { problems, warns };
}

(async () => {
  const FLAGS = ['--placeholder', '--check', '--new-version'];
  /* --icon 与其文件参数不进位置参数序列（rest），避免与 <srcFile>/<flowFile>/<description> 错位 */
  const argv = process.argv.slice(2);
  const iconIdxRaw = argv.indexOf('--icon');
  let iconFileArg = null;
  if (iconIdxRaw !== -1) {
    iconFileArg = argv[iconIdxRaw + 1];
    if (!iconFileArg || iconFileArg.startsWith('--')) fail('--icon 需要跟一个 SVG 文件路径');
  }
  const rest = argv
    .filter((a, i) => !FLAGS.includes(a) && !a.startsWith('--host-mode=') && !a.startsWith('--kind=')
      && !a.startsWith('--long-running=') && a !== '--icon' && !(iconIdxRaw !== -1 && i === iconIdxRaw + 1));
  const usePlaceholder = process.argv.includes('--placeholder');
  const checkOnly = process.argv.includes('--check');
  const newVersion = process.argv.includes('--new-version');
  /* 脚本级宿主覆盖：--host-mode=fork|inprocess|worker（可选；不传继承上一版 / 跟随全局 EXECUTION_MODE） */
  const hm = (process.argv.find((a) => a.startsWith('--host-mode=')) || '').split('=')[1];
  if (hm && !['fork', 'inprocess', 'worker'].includes(hm)) fail(`--host-mode 非法：${hm}（仅允许 fork / inprocess / worker）`);
  /* 业务种类：--kind=automation|script|scene（可选；不传继承上一版 / 全新默认 automation）。
   * 运行模型由 kind 派生：automation=常驻；script/scene=一次性动作（跑完即退）。
   * 旧参数 --long-running 已退役（传入即忽略，仅从位置参数中过滤掉）。 */
  const kind = (process.argv.find((a) => a.startsWith('--kind=')) || '').split('=')[1];
  if (kind && !['automation', 'script', 'scene'].includes(kind)) fail(`--kind 非法：${kind}（仅允许 automation / script / scene）`);
  /* 脚本图标：--icon <icon.svg>（新脚本首次提交必填；迭代不传则继承上一版） */
  let icon = null;
  if (iconFileArg) {
    if (!fs.existsSync(iconFileArg)) fail(`icon 文件不存在：${iconFileArg}`);
    icon = fs.readFileSync(iconFileArg, 'utf8').trim();
  } else {
    console.warn('⚠ 未提供 --icon：将继承上一版图标；新脚本首次提交必须提供（规范见 references/file-specs.md §icon）');
  }
  /* 位置参数固定语义，避免"同名 flag 被吞 / .json 结尾的描述误判为文件"的静默错位：
   * rest[0]=scriptId  rest[1]=name  rest[2]=srcFile  rest[3]=flowFile  rest[4]=description */
  const [scriptId, name, srcFile, flowFile, description] = rest;
  if (!scriptId || !name || !srcFile) fail(USAGE);
  if (!/^[a-z0-9_-]+$/i.test(scriptId)) fail(`scriptId 不合法：${scriptId}（仅字母数字下划线短横线）`);
  if (name.toLowerCase() === scriptId.toLowerCase()) fail(`脚本名不能与唯一 id 相同（"${name}"）——请传贴切的中文业务名，如「空调运行关门预警」`);
  if (/^[a-z0-9]{8}$/.test(name) && !/[^\x00-\x7F]/.test(name)) fail(`脚本名疑似是 id（"${name}"）——请传贴切的中文业务名，前端列表展示的是 name`);
  if (!fs.existsSync(srcFile)) fail(`脚本源文件不存在：${srcFile}`);
  const script = fs.readFileSync(srcFile, 'utf8');

  let flow;
  if (usePlaceholder) {
    flow = placeholderFlow(scriptId);
    console.warn('⚠ 使用 --placeholder：写入通用三节点占位流程，仅适合链路联通测试，正式交付前必须补真实 flow.json');
  } else {
    if (!flowFile) fail('缺少 flow.json\n\n' + USAGE);
    if (!fs.existsSync(flowFile)) fail(`flow 文件不存在：${flowFile}`);
    try { flow = JSON.parse(fs.readFileSync(flowFile, 'utf8')); } catch (e) { fail(`flow.json 解析失败：${e.message}`); }
    const { problems, warns } = checkFlowAgainstScript(flow, script);
    for (const w of warns) console.warn('⚠ ' + w);
    if (problems.length) fail('flow.json 与 script.js 不一致：\n- ' + problems.join('\n- '));
    console.log(`[check] flow 节点 ${flow.nodes.length} 个 / 边 ${flow.edges.length} 条，${warns.length ? '通过（有警告，见上）' : '与脚本 nodeId 完全对齐'}`);
  }

  if (checkOnly) {
    console.log('[check] 仅校验模式，未提交');
    process.exit(0);
  }

  const args = {
    scriptId, name, script, flow, description: description || name,
    channel: 'shadow', confirmed: true,
    ...(kind ? { kind } : {}),
    ...(newVersion ? { newVersion: true } : {}),
    ...(hm ? { hostMode: hm } : {}),
    ...(icon ? { icon } : {}),
  };
  const client = new Client({ name: 'migration-submit', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL(process.env.HA3D_MCP || 'http://127.0.0.1:8100/mcp/sse')));
  try {
    const r = await client.callTool({ name: 'automation_submit_script', arguments: args });
    const out = (r.content || []).map((c) => c.text).join('\n');
    if (r.isError) { console.error('SUBMIT_ERROR: ' + out); process.exit(2); }
    console.log(out);
  } finally { await client.close(); }
})().catch((e) => { console.error('ERR ' + (e && e.message || e)); process.exit(1); });
