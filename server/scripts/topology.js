'use strict';
/* 运行时拓扑观测：记录脚本实例"真实发生过"的实体读写与上下文写入。
 *
 * 设计口径（用户 2026-11-25 确认的方案一）：
 * - 观测而不是解析：只在 executor 的真实拦截点记录，脚本侧零声明、零维护。
 * - 按 scriptId + mode(shadow/production) + version 分组；同一组换版本时清空重来，
 *   保证展示的是当前运行版本的行为，不混入旧版本残留。
 * - 彻底纯内存存储（用户 2026-11-26 确认）：不落盘、零磁盘写入，重启即从零重新观测；
 *   正在运行的脚本恢复实例时会立即重新订阅/读取，观测秒级重建。
 * - 影子模式下 ctx.write 在脚本层就被拦、动作函数不执行，所以 callService 观测不到
 *   "改了哪些实体"——这是预期（真实没发生），读实体/订阅/上下文写入不受影响。 */
let data = null;          // { updatedAt, scripts: { [sid]: { [mode]: {...} } } }

function emptyGroup(sid, mode, version) {
  return {
    scriptId: sid,
    mode,
    version,
    reads: [],        // 依赖实体（getState / subscribe）
    writes: [],       // 修改实体（callService，entity_id）
    services: [],     // 调用过的 HA 服务（domain.service，即使无 entity_id）
    contextReads: [], // 读取/订阅的上下文（scope.key）
    contexts: [],     // 写入的上下文（scope.key）
    calls: [],        // ctx.call 调用过的其他脚本 id（脚本间控制流）
    taskDeps: [],     // task.status/require/watch 查询/等待/订阅过的脚本 id（脚本间状态依赖）
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };
}

function load() {
  if (data) return data;
  data = { updatedAt: null, scripts: {} };
  return data;
}

/* 取（或建）一个分组。version 变化时整组重置——代表这个版本从头观测。 */
function group(sid, mode, version) {
  const root = load();
  const id = String(sid || '');
  if (!id) return null;
  const m = mode === 'shadow' ? 'shadow' : 'production';
  let byMode = root.scripts[id];
  if (!byMode) { byMode = {}; root.scripts[id] = byMode; }
  let g = byMode[m];
  if (!g || Number(g.version) !== Number(version)) {
    g = emptyGroup(id, m, version);
    byMode[m] = g;
  }
  g.lastSeen = new Date().toISOString();
  root.updatedAt = g.lastSeen; // 纯内存化后由观测动作实时刷新（原落盘版在 flush 时写）
  return g;
}

function pushUnique(arr, value) {
  const v = String(value || '');
  if (!v || arr.includes(v)) return;
  arr.push(v);
}

/* 记录一次读实体（getState）或订阅实体（subscribe） */
function observeRead(sid, mode, version, entityId) {
  const eid = String(entityId || '');
  if (!eid) return;
  const g = group(sid, mode, version);
  if (g) pushUnique(g.reads, eid);
}

/* 记录一次 HA 服务调用（callService）。entity_id 可为空（如 text 服务的全局动作）。 */
function observeService(sid, mode, version, domain, service, entityId) {
  const g = group(sid, mode, version);
  if (!g) return;
  pushUnique(g.services, `${domain || ''}.${service || ''}`);
  if (entityId) pushUnique(g.writes, String(entityId));
}

/* 记录一次上下文读取/订阅（contextGet / contextSubscribe） */
function observeContextRead(sid, mode, version, scope, key) {
  const g = group(sid, mode, version);
  if (!g) return;
  pushUnique(g.contextReads, `${scope || 'global'}.${key || ''}`);
}

/* 记录一次上下文写入（contextSet） */
function observeContext(sid, mode, version, scope, key) {
  const g = group(sid, mode, version);
  if (!g) return;
  pushUnique(g.contexts, `${scope || 'global'}.${key || ''}`);
}

/* 记录一次脚本间调用（ctx.call）。目标记脚本 id；自调用不记（拓扑画自环无意义） */
function observeCall(sid, mode, version, targetSid) {
  const t = String(targetSid || '');
  if (!t || t === String(sid || '')) return;
  const g = group(sid, mode, version);
  if (g) pushUnique(g.calls, t);
}

/* 记录一次脚本间状态依赖（task.status / task.require / task.watch）。方向口径：观察者侧观测，记目标脚本 id */
function observeTaskDep(sid, mode, version, targetSid) {
  const t = String(targetSid || '');
  if (!t || t === String(sid || '')) return;
  const g = group(sid, mode, version);
  if (g) pushUnique(g.taskDeps, t);
}

/* 读取某个脚本的拓扑（全部通道）；返回深拷贝，避免调用方改动内存缓存 */
function get(sid) {
  const root = load();
  const id = String(sid || '');
  const byMode = root.scripts[id] || {};
  return { scriptId: id, topology: JSON.parse(JSON.stringify(byMode)) };
}

/* 读取全部（调试/导出用） */
function all() {
  const root = load();
  return JSON.parse(JSON.stringify(root));
}

/* 清空某脚本（或全部）的观测数据 */
function clear(sid) {
  const root = load();
  if (sid == null || sid === '') root.scripts = {};
  else delete root.scripts[String(sid)];
}

module.exports = {
  observeRead, observeService, observeContextRead, observeContext,
  observeCall, observeTaskDep,
  get, all, clear,
};
