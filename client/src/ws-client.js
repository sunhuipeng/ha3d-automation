/* WS 客户端：后端广播 → Pinia store。
 * - MCP 顶部横条：对齐 studio 的 onMcpEvent 三态收敛与展示节奏
 *   busy 至少 900ms / done 保留 4000ms / 连接期 180s 无动作收起
 * - refresh.what 重拉对应 store（scripts / logs）
 * - script 事件：运行态 + 日志追加；节点状态只在内存里更新，flow.json 不变（展示层只读） */
import { useAppStore } from './stores/app';
import { useScriptStore } from './stores/scripts';

const MCP_MIN_BUSY_MS = 900;
const MCP_KEEP_DONE_MS = 4000;
const MCP_IDLE_MS = 180000;

const mcp = { sessions: 0, busy: false, tool: '', cost: 0, since: 0 };
let mcpTimer = null;
let mcpPending = null;
const fmtCost = (ms) => (ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's');

function renderMcp() {
  const app = useAppStore();
  clearTimeout(mcpTimer);
  if (mcp.busy) {
    app.mcp = { active: true, connected: true, busy: true, text: `MCP 正在执行：${mcp.tool}…` };
    return;
  }
  if (mcp.sessions > 0) {
    app.mcp = {
      active: true, connected: true, busy: false,
      text: mcp.tool ? `MCP 已执行：${mcp.tool}（${fmtCost(mcp.cost)}），等待指令…` : 'MCP 已连接，等待指令…',
    };
    mcpTimer = setTimeout(() => { app.mcp.active = false; }, MCP_IDLE_MS);
    return;
  }
  if (mcp.tool) {
    app.mcp = { active: true, connected: false, busy: false, text: `MCP 已执行：${mcp.tool}（${fmtCost(mcp.cost)}）` };
    mcpTimer = setTimeout(() => { mcp.tool = ''; renderMcp(); }, MCP_KEEP_DONE_MS);
    return;
  }
  app.mcp = { active: false, connected: false, busy: false, text: '' };
}

function onMcpEvent(msg) {
  if (msg.event === 'connected') mcp.sessions = Number(msg.sessions) || 1;
  else if (msg.event === 'disconnected') mcp.sessions = Math.max(0, Number(msg.sessions) || 0);
  else if (msg.event === 'activity') {
    clearTimeout(mcpPending); mcpPending = null;
    mcp.busy = true; mcp.tool = msg.tool || '…'; mcp.since = Date.now();
  } else if (msg.event === 'idle') {
    const cost = mcp.since ? Date.now() - mcp.since : 0;
    if (msg.tool) mcp.tool = msg.tool;
    clearTimeout(mcpPending);
    mcpPending = setTimeout(() => {
      mcpPending = null; mcp.busy = false; mcp.cost = cost; renderMcp();
    }, Math.max(0, MCP_MIN_BUSY_MS - cost));
  }
  renderMcp();
}

function onScriptEvent(msg) {
  const s = useScriptStore();
  /* 日志按 (scriptId, version) 双重过滤：同脚本的正式与影子实例同时在跑、各自广播，
   * 只按 scriptId 过滤会把另一版本的日志串进当前面板（v3 正式串台 v4 影子的根因）。 */
  if (msg.event === 'log' && s.current && msg.scriptId === s.current.id && msg.version === s.current.version) {
    if (msg.nodeId) s.nodeStates[msg.nodeId] = msg.level === 'error' ? 'error' : (s.nodeStates[msg.nodeId] || 'ok');
    s.pushLog(msg);
  }
  if (msg.event === 'status' && s.current && msg.scriptId === s.current.id) {
    s.setStatus(msg.status, msg.version, msg.mode, msg.verifyMode);
    if (msg.status === 'running') s.nodeStates = {};
  }
  // 发布后的版本角色变化统一交给 refresh what:'versions'（executor.publish 已广播），
  // 不再在 script 事件里手写 loadVersions（B4：避免两套刷新口径）。
}

function onRefresh(msg) {
  const s = useScriptStore();
  if (msg.what === 'scripts') s.load();
  /* 提交/回滚后重拉详情：广播带 scriptId/version 时切到刚提交的版本（如新影子 v2），
   * 否则保持原行为重拉当前打开的版本。正文/流程图/版本条/日志一次到位。 */
  if (msg.what === 'script') {
    const id = msg.scriptId || (s.current && s.current.id);
    const version = msg.version || (s.current && s.current.version);
    if (id) s.open(id, version).catch(() => {});
  }
  if (msg.what === 'versions' && s.current) s.loadVersions(s.current.id);
  if (msg.what === 'logs' && s.current) {
    s.loadLogs(s.current.id, s.current.version, 100, s.logsSourceForCurrent());
  }
  // flows：flow.json 按版本不可变、前端预览只读投影；提交变更走 what:'script' 整体重拉
  // entities：当前无实体浏览页，HA 状态经 ha 事件与 getState 按需读取，契约不再列此 what
}

let ws = null;
let reconnectTimer = null;

export function startWs() {
  const app = useAppStore();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const connect = () => {
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => {
      const firstConnect = !app.wsConnected && app.wsEverConnected !== true;
      app.wsConnected = true;
      app.wsEverConnected = true;
      /* 断线期间的 refresh/script/ha 事件全部丢失：重连后全量重拉，
       * 否则面板会长期展示旧状态（旧的运行态、旧的 HA 徽标）直到下一次事件 */
      if (!firstConnect) {
        const s = useScriptStore();
        s.load();
        if (s.current) s.open(s.current.id, s.current.version).catch(() => {});
      }
      /* HA 徽标只在状态变化时广播，断线期间的状态迁移要靠重拉补齐 */
      app.loadHealth().catch(() => {});
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'mcp') return onMcpEvent(msg);
      if (msg.type === 'script') return onScriptEvent(msg);
      if (msg.type === 'refresh') return onRefresh(msg);
      if (msg.type === 'select') {
        /* MCP 切换前端选中项：左侧列表选中并打开该脚本详情 */
        const s = useScriptStore();
        s.open(msg.scriptId, msg.version).catch(() => {});
        return;
      }
      if (msg.type === 'ha') return app.setHaStatus(msg.status);
      if (msg.type === 'welcome') return;
    };
    ws.onclose = () => {
      app.wsConnected = false;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 2000);
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  };
  connect();
}
