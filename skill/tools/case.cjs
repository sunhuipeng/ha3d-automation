#!/usr/bin/env node
/* 可复用仿真用例（skill/.fixtures）的管理与执行器。
 *
 * 用法:
 *   node skill/tools/case.cjs list
 *   node skill/tools/case.cjs show <case>
 *   node skill/tools/case.cjs run  <case> [--continue] [--fail-fast]
 *   node skill/tools/case.cjs push <case> [--run-fixture]
 *   node skill/tools/case.cjs save <scriptId> <name>      # sim_export 后归档进本库
 *   node skill/tools/case.cjs finish <scriptId>            # 仿真收尾：切回 follow 并确认影子在跑
 *
 * <case> 可以是：用例名（highpower-3s-30s）、<scriptId>/<用例名>（m7orioe9/highpower-3s-30s）
 * 或任意 json 文件路径。用例格式见 skill/.fixtures/README.md。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { callToolText } = require('./lib/mcp.cjs');

const SKILL = path.resolve(__dirname, '..');
/* 用例目录与服务端同一份（config.FIXTURES 默认也是 skill/.fixtures）：不再有 data/fixtures 副本。 */
const FIXTURES = path.join(SKILL, '.fixtures');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

const relName = (f) => path.relative(FIXTURES, f).split(path.sep).join('/').replace(/\.json$/, '');

function resolveCase(arg) {
  if (!arg) throw new Error('缺少用例名（先 case.cjs list）');
  if (fs.existsSync(arg) && fs.statSync(arg).isFile()) {
    return { file: path.resolve(arg), label: path.basename(arg, '.json') };
  }
  const all = walk(FIXTURES);
  const norm = String(arg).replace(/\\/g, '/').replace(/\.json$/, '');
  const hit = all.find((f) => relName(f) === norm)
    || all.find((f) => relName(f).endsWith('/' + norm))
    || all.find((f) => path.basename(f, '.json') === norm);
  if (!hit) throw new Error(`没有这个用例：${arg}（先 case.cjs list）`);
  return { file: hit, label: relName(hit) };
}

function readCase(file) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!c.scriptId) throw new Error('用例缺少 scriptId');
  if (!Array.isArray(c.steps) || !c.steps.length) throw new Error('用例缺少 steps');
  return c;
}

const short = (v, n = 220) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s == null ? String(s) : (s.length > n ? s.slice(0, n) + '…' : s);
};

const tool = async (name, payload) => JSON.parse(await callToolText(name, payload, { clientName: 'ha3d-case' }));

/* 统一展示 run_steps / run_fixture 的返回体：先给结论，再给失败点，最后给硬证据。 */
function report(d, { withDrift = false } = {}) {
  console.log(`ok=${d.ok}  passed=${d.passed}/${d.total}  failed=${d.failed}` +
    (d.executed !== undefined ? `  executed=${d.executed}` : '') +
    (d.aborted ? '  aborted=true' : ''));
  if (withDrift && d.fixture) console.log(`versionDrift=${d.fixture.versionDrift}`);

  const steps = d.steps || [];
  for (const s of steps) {
    if (s.op !== 'assert') {
      if (s.ok === false) console.log(`  STEP-ERR #${s.index} ${s.op}: ${s.error}`);
      continue;
    }
    if (s.passed) { console.log(`  PASS ${s.label || ''}`); continue; }
    console.log(`  FAIL ${s.label || ''}`);
    for (const c of (s.checks || []).filter((x) => !x.pass)) {
      console.log(`    ✗ ${c.kind}: ${c.message || ''}`);
      console.log(`      expected=${short(c.expected)}`);
      console.log(`      actual  =${short(c.actual)}`);
    }
  }

  const writes = (d.final && d.final.writes) || [];
  console.log(`writes=${writes.length}  clockNow=${d.final && d.final.clockNow}` +
    `  seq=${d.final && d.final.seq}`);
  for (const w of writes) console.log(`  W +${w.at}ms ${w.kind}/${w.op} ${short(w.args, 120)}`);
}

async function cmdRun(args) {
  const { file, label } = resolveCase(args[0]);
  const c = readCase(file);
  const reuse = args.includes('--continue');
  const payload = { scriptId: c.scriptId, steps: c.steps, confirmed: true };
  if (reuse) payload.continue = true;
  else {
    if (c.startAt) payload.startAt = c.startAt;
    if (c.seed) payload.seed = c.seed;
  }
  if (args.includes('--fail-fast')) payload.failFast = true;

  console.log(`▶ ${label}（${c.scriptId}，${c.steps.length} 步${reuse ? '，续跑现有会话' : '，重建世界'}）`);
  const out = await callToolText('automation_sim_run_steps', payload, { clientName: 'ha3d-case' });
  const d = JSON.parse(out);
  report(d);
  let ok = d.ok;

  /* steps 里的 assert 会各自消耗 seq 游标，所以"全序列写意图"要单独用 sim_assert + since:0 验一遍。 */
  const expected = ((c.expected || {}).writes) || [];
  if (expected.length) {
    const aOut = await callToolText('automation_sim_assert', {
      scriptId: c.scriptId, since: 0, writes: expected, label: `expected:全序列(${expected.length}条)`, confirmed: true,
    }, { clientName: 'ha3d-case' });
    const a = JSON.parse(aOut);
    console.log(`  全序列断言：${a.ok ? 'PASS' : 'FAIL'} ${a.label || ''}`);
    for (const chk of (a.checks || []).filter((x) => !x.pass)) {
      console.log(`    ✗ ${chk.kind}: ${chk.message || ''}`);
      console.log(`      expected=${short(chk.expected)}`);
      console.log(`      actual  =${short(chk.actual)}`);
    }
    if (!a.ok) ok = false;
  }

  if (!ok) process.exitCode = 1;
}

function cmdList() {
  const files = walk(FIXTURES);
  if (!files.length) { console.log('（空）用例放 skill/.fixtures/<scriptId>/<name>.json，格式见 .fixtures/README.md'); return; }
  for (const f of files) {
    let c;
    try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.log(`! ${relName(f)} 解析失败：${e.message}`); continue; }
    const asserts = (c.steps || []).filter((s) => s.op === 'assert').length;
    const adv = (c.steps || []).filter((s) => s.op === 'advance').length;
    const exp = ((c.expected || {}).writes || []).length;
    console.log(`${relName(f).padEnd(38)} steps=${String((c.steps || []).length).padEnd(3)} ` +
      `advance=${String(adv).padEnd(3)} assert=${String(asserts).padEnd(3)} expected=${String(exp).padEnd(3)} ` +
      `${c.note || ''}`);
  }
}

function cmdShow(args) {
  const { file, label } = resolveCase(args[0]);
  const c = readCase(file);
  console.log(`# ${label}\n` + JSON.stringify(c, null, 2));
}

/* 用例与服务端读写的是同一份文件（skill/.fixtures），push 不再复制，只保留「服务端重放」这一步。 */
async function cmdPush(args) {
  const { file, label } = resolveCase(args[0]);
  const c = readCase(file);
  const name = c.name || path.basename(file, '.json');
  console.log(`▶ ${label}：已在 skill/.fixtures 中，服务端 sim_run_fixture 直接读这里，无需复制`);

  if (!args.includes('--run-fixture')) {
    console.log('（要服务端重放加 --run-fixture；只验断言用 case.cjs run 更快）');
    return;
  }
  const expected = ((c.expected || {}).writes) || [];
  const hasAsserts = c.steps.some((s) => s.op === 'assert');
  if (!hasAsserts && !expected.length) {
    console.log('! 用例既没有 steps.assert 也没有 expected.writes，重放无法判定对错；请补断言');
    process.exitCode = 1;
    return;
  }
  const out = await callToolText('automation_sim_run_fixture', { scriptId: c.scriptId, name, confirmed: true }, { clientName: 'ha3d-case' });
  const d = JSON.parse(out);
  report(d, { withDrift: true });
  if (!d.ok) process.exitCode = 1;
}

async function cmdSave(args) {
  const [scriptId, name] = args;
  if (!scriptId || !name) throw new Error('用法: case.cjs save <scriptId> <name>（导出当前仿真会话为可复用用例）');
  /* 导出会直接落到 skill/.fixtures/<id>/<name>.json；若同名用例已带断言（手写资产），
   * 不静默覆盖——导出的 fixture 没有断言，覆盖等于把资产降级。 */
  const target = path.join(FIXTURES, scriptId, name + '.json');
  if (fs.existsSync(target) && !args.includes('--force')) {
    let old = null;
    try { old = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (e) { /* 坏文件按可覆盖处理 */ }
    if (old && (old.steps || []).some((s) => s.op === 'assert')) {
      throw new Error(`${path.relative(SKILL, target)} 已存在且带断言，拒绝覆盖（导出的 fixture 没有断言）；换个 name 或加 --force`);
    }
  }
  const payload = { scriptId, name, confirmed: true };
  if (args.includes('--force')) payload.force = true;
  const out = await callToolText('automation_sim_export', payload, { clientName: 'ha3d-case' });
  const d = JSON.parse(out);
  console.log(`导出 → ${d.file}（${d.steps} 步 / ${d.writes} 条写意图）`);
  console.log('提示：补一句 note 说明这段用例锁住什么行为，再把 .fixtures/README.md 的索引表更新一行。');
}

/* 仿真收尾（固定节点）：仿真不是终点，publish 之前必须让影子以真实数据跑一轮。
 * switch_verify_mode 内部就是「停仿真 → 以 follow 重启同一影子版本」，一步到位；
 * 这里再查一次状态兜底启动，确保"切回去"和"真的在跑"是同一件事而不是两个假设。
 * 注意：不要用 sim_close 收尾——它只销毁虚拟世界并停实例，不会回 follow。 */
async function cmdFinish(args) {
  const scriptId = args[0];
  if (!scriptId) throw new Error('用法: case.cjs finish <scriptId>');

  const sw = await tool('automation_switch_verify_mode', { scriptId, mode: 'follow', confirmed: true });
  if (sw.to !== 'follow') throw new Error(`切换失败：目标模式是 ${sw.to}（${sw.error || '见服务端日志'}）`);
  console.log(`模式：${sw.from} → follow${sw.idempotent ? '（本来就在 follow，幂等）' : ''}  影子 v${sw.version}` +
    (sw.pausedMs !== undefined ? `  暂停 ${sw.pausedMs}ms` : ''));

  let st = await tool('automation_get_script_status', { scriptId });
  let shadow = (st.runningVersions || []).find((v) => v.mode === 'shadow');
  if (!shadow) {
    /* 切回时若没把实例拉起来（例如外部 stop 过），补一次显式启动；版本必须点名影子，
     * 不传 version 会取最高版本号——正式版号更高时会误启正式实例。 */
    const vs = (st.versions || []).filter((v) => v.channel === 'shadow').map((v) => v.version);
    const version = vs.length ? Math.max(...vs) : undefined;
    console.log(`! follow 实例没有在跑，补一次启动（影子 v${version}）`);
    await tool('automation_start_script', { scriptId, version, confirmed: true });
    st = await tool('automation_get_script_status', { scriptId, version });
    shadow = (st.runningVersions || []).find((v) => v.mode === 'shadow');
  }
  if (!shadow) {
    console.error('ERR 影子实例仍未运行，请查 automation_get_script_status 与 version 日志');
    process.exitCode = 1;
    return;
  }
  if (shadow.verifyMode !== 'follow') {
    console.error(`ERR 影子 v${shadow.version} 的 verifyMode=${shadow.verifyMode}，不是 follow`);
    process.exitCode = 1;
    return;
  }

  console.log(`status=${st.status}  影子 v${shadow.version}  verifyMode=follow  host=${shadow.host}  启动于 ${new Date(shadow.startedAt).toLocaleString()}`);

  const vst = await tool('automation_get_script_status', { scriptId, version: shadow.version, logLimit: 20 });
  const logs = vst.logs || [];
  const errs = logs.filter((l) => l.level === 'error');
  for (const l of logs.slice(-5)) console.log(`  ${l.level.padEnd(5)} ${String(l.message || '').slice(0, 120)}`);
  if (errs.length) {
    console.error(`! 最近日志有 ${errs.length} 条 error，先排掉再进真实观察`);
    process.exitCode = 1;
    return;
  }
  console.log('下一步：请用户在 HA 侧造触发条件，看触发 → 判据 → 动作是否走通；写意图应只见「[影子·拦截写操作]」。');
}

const HELP = `可复用仿真用例（skill/.fixtures，服务端与 case.cjs 读写同一份）

  node skill/tools/case.cjs list                         列出所有用例
  node skill/tools/case.cjs show <case>                  查看用例原文
  node skill/tools/case.cjs run  <case> [--continue] [--fail-fast]
                                                         直接喂 sim_run_steps（默认重建世界）
  node skill/tools/case.cjs push <case> [--run-fixture]   走服务端 sim_run_fixture 重放（不复制）
  node skill/tools/case.cjs save <scriptId> <name>        导出当前仿真会话为本目录用例（--force 才覆盖带断言的同名用例）
  node skill/tools/case.cjs finish <scriptId>             仿真收尾：切回 follow（影子模式）、确认影子实例在跑

<case> 支持：highpower-3s-30s / m7orioe9/highpower-3s-30s / 任意 .json 路径
`;

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'list': cmdList(); break;
      case 'show': cmdShow(args); break;
      case 'run': await cmdRun(args); break;
      case 'push': await cmdPush(args); break;
      case 'save': await cmdSave(args); break;
      case 'finish': await cmdFinish(args); break;
      default: console.log(HELP); process.exitCode = cmd && cmd !== 'help' ? 1 : 0;
    }
  } catch (e) {
    console.error('ERR ' + (e && e.message || e));
    process.exit(1);
  }
})();
