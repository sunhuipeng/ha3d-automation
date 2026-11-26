'use strict';
/* 共享运行实例：路由与 MCP 都 require 这里，避免 index.js 组装时到处传 ctx。
 * 各域路由文件零参：module.exports = function xxxRoutes() { const r = express.Router(); ... } */
const { HaConnector } = require('../ha/connector');
const hub = require('./ws-hub');
const store = require('../scripts/store');
const executor = require('../scripts/executor');
const { getConfig } = require('../config');

const connector = new HaConnector({
  onStateChange: (eid, next, prev) => executor.onStateChange(eid, next, prev),
  /* 兜底：掉线 → 挂起所有脚本；重连且 get_states 回填完成 → 恢复脚本。
   * 只有真正不可用的状态才挂起；'connected' 要等 onReady（缓存新鲜）才恢复。 */
  onStatus: (s) => {
    hub.broadcast({ type: 'ha', status: s, ts: Date.now() });
    if (s === 'reconnecting' || s === 'error' || s === 'disconnected') executor.onHaOffline();
  },
  onReady: () => executor.onHaReady(),
});

function startConnector() { connector.start(); }

/* 启动恢复入口：等 HA 连接器真正就绪（缓存回填完成 / demo）后再恢复脚本，
 * 否则脚本启动时读取实体状态会从空缓存拿到 null（倒计时脚本会误判为 0）。
 * 用 connector.isReady() 作为唯一就绪真相（不能轮询 status==='connected'——
 * auth_ok 即置 connected，早于 subscribe_entities 快照回填，会以空缓存启动脚本）。
 * HA 长时间不可达时用超时兜底，避免服务永远不恢复；此时脚本靠实时状态事件补齐。 */
function restoreOnReady() {
  const TIMEOUT_MS = 8000;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    clearTimeout(timeout);
    const result = executor.restore(connector);
    if (result.restored.length) {
      console.log('[startup] 已从运行意图清单恢复 ' + result.restored.length + ' 个脚本：' +
        result.restored.map((x) => x.id + '@v' + x.version).join(', '));
    }
    if (result.skipped.length) {
      console.warn('[startup] 运行意图恢复跳过 ' + result.skipped.length + ' 项：' +
        result.skipped.map((x) => x.id + '@v' + (x.version || '?') + '(' + x.reason + ')').join(', '));
    }
    return result;
  };
  const timer = setInterval(() => { if (connector.isReady()) finish(); }, 100);
  const timeout = setTimeout(finish, TIMEOUT_MS);
}

/* allowMcpCallService 用 getter 读实时配置：saveConfig 会重置缓存，
 * 模块加载时的快照会导致开关改了也不生效（F6 跨层碎片）。 */
const mcpCtx = {
  connector, executor, hub,
  get allowMcpCallService() { return getConfig().allowMcpCallService === true; },
};

module.exports = { connector, hub, store, executor, mcpCtx, startConnector, restoreOnReady };
