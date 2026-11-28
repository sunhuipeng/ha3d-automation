'use strict';
/* sim.log 唯一读写实现（审计 3.6）：主进程（store）与 worker（worker-runner）共用，
 * 写契约集中在这一个模块，不再靠两边各自实现的隐式约定协同。
 *
 * 生命周期契约：
 *   1. 清空只由主进程做——executor.start(simulate 分支) 在会话起点调 clear()；
 *      worker 打开文件必须用追加模式，'w' 会抹掉主进程先落的框架日志（如 [模式切换]）。
 *   2. 追加双源：主进程 appendLine()（框架日志，同步）+ worker 流式写（脚本日志，异步流）。
 *   3. 格式统一 JSON 行：{ ts, at?, level, message, nodeId? }；at=虚拟时刻毫秒，仅仿真日志有。
 */
const fs = require('fs');
const path = require('path');

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }

/* 主进程：仿真会话开始时清空（覆盖为空文件；无旧文件也属正常） */
function clear(file) {
  try { fs.writeFileSync(file, ''); } catch (e) { /* 无旧文件也属正常 */ }
}

/* 主进程：框架日志同步追加（单条 JSON 行） */
function appendLine(file, entry) {
  ensureDir(file);
  fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
}

/* worker：会话期流式追加。必须 'a' 追加——清空职责在主进程（见上方契约 1） */
function openStream(file) {
  ensureDir(file);
  const s = fs.createWriteStream(file, { flags: 'a' });
  s.on('error', () => { /* 日志写失败不影响仿真 */ });
  return s;
}

module.exports = { clear, appendLine, openStream };
