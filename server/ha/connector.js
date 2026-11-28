'use strict';
/* HA 连接器：服务端持有 token，连接 HA WebSocket，缓存实体状态，订阅实时变更。
 * 数据面（借鉴 ha-3d-home）：subscribe_entities 一条通道拿全量快照 + 增量 diff 推送，
 * 本地合并出全量数据；老版本 HA 退回 get_states + subscribe_events。
 * 状态查询走 WS 缓存、服务下发与历史走 WS 指令；未配置 HA 时进入 demo 模式。 */
const { WebSocket } = require('ws');
const { getConfig } = require('../config');

const HEARTBEAT_MS = 30000;    // 心跳间隔
const PONG_TIMEOUT_MS = 12000; // 发 ping 后等 pong 的上限，超时判定半开连接

function wsUrl(base) {
  const u = new URL(base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/api/websocket';
  u.search = '';
  return u.toString();
}

class HaConnector {
  constructor(opts = {}) {
    this.getConfig = opts.getConfig || getConfig;
    this.onStateChange = opts.onStateChange || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    /* onReady：连接认证成功且 get_states 全量回填完成后触发，供执行器解除脚本挂起。
     * 用独立回调而非复用 onStatus('connected')，因为 auth_ok 先于缓存回填，
     * 若此刻恢复脚本会读到空缓存而误判（B 类问题）。 */
    this.onReady = opts.onReady || (() => {});
    this.ready = false;          // 实体缓存是否是"新鲜可用"的（demo 视为就绪）
    this.entities = new Map();   // eid -> { entity_id, state, attributes, last_changed, ... }
    this.services = {};          // domain -> { service: { description, fields } }
    this._registry = null;       // config/entity_registry/list 缓存（device_id -> 实体解析用）
    this.pending = new Map();    // id -> { resolve, reject, timer }
    this.seq = 0;
    this.ws = null;
    this.status = 'disconnected';
    this.demo = false;
    this.demoTimer = null;
    this.heartbeat = null;
    this.reconnectTimer = null;
    this.stopped = false;
    this._entitySub = false; // 本连接的增量通道：true=subscribe_entities diff，false=state_changed 事件
  }

  start() {
    this.stopped = false;
    const cfg = this.getConfig();
    if (!cfg.haUrl || !cfg.token) { this._startDemo(); return; }
    this.demo = false;
    this.ready = false;
    this._connect();
  }

  /* 实体缓存是否新鲜可用：demo 恒就绪；真实连接需认证 + 全量状态回填完成。
   * 断线/半开时返回 false，getState 不返回陈旧快照，避免脚本基于旧状态误判。 */
  isReady() { return this.demo === true || this.ready === true; }

  /* 改配置后重连：stop() 已清理全部定时器与连接，这里只重置缓存态 */
  restart() {
    this.stop();
    this.entities.clear();
    this.services = {};
    this._registry = null;
    this.ready = false;
    this.demo = false;
    this.start();
  }

  stop() {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    clearTimeout(this.pongTimer);
    clearInterval(this.demoTimer);
    if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('HA 连接器已停止')); }
    this.pending.clear();
    this._setStatus('disconnected');
  }

  _setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  }

  _startDemo() {
    this.demo = true;
    /* 审计 4.1：必须先填充实体/服务，再置 ready 并通知 onReady——
     * onHaReady 会用 entityStatus 复核运行脚本依赖，空表会把所有实体判 missing，
     * 导致刚恢复/启动的脚本被整体误暂停（只有 10s 后 sensor.temperature 变化能救回一个）。 */
    const demo = [
      ['light.living', 'on', { friendly_name: '客厅灯', brightness: 180 }],
      ['light.bedroom', 'off', { friendly_name: '卧室灯' }],
      ['switch.fan', 'off', { friendly_name: '风扇开关' }],
      ['sensor.temperature', '23.5', { friendly_name: '室温', unit_of_measurement: '°C' }],
      ['sensor.humidity', '62', { friendly_name: '湿度', unit_of_measurement: '%' }],
      ['cover.curtain', 'closed', { friendly_name: '窗帘' }],
    ];
    this.entities.clear();
    for (const [eid, state, attributes] of demo) {
      this.entities.set(eid, { entity_id: eid, state, attributes, demo: true });
    }
    this.services = { light: { turn_on: {}, turn_off: {}, toggle: {} }, switch: { turn_on: {}, turn_off: {} }, cover: { open_cover: {}, close_cover: {}, stop_cover: {} } };
    this.ready = true;
    this._setStatus('demo');
    this.onReady();
    this.demoTimer = setInterval(() => {
      const e = this.entities.get('sensor.temperature');
      if (!e) return;
      /* L3：prev 必须是变更前的副本，否则 prev.state === next.state，订阅者判断不出变化。 */
      const prev = { ...e };
      const next = { ...e, state: String((20 + Math.random() * 5).toFixed(1)) };
      this.entities.set(e.entity_id, next);
      this.onStateChange(e.entity_id, next, prev);
    }, 10000);
  }

  _connect() {
    if (this.stopped) return;
    const cfg = this.getConfig();
    let url;
    try { url = wsUrl(cfg.haUrl); } catch (e) { this._scheduleReconnect(); return; }
    let ws;
    try { ws = new WebSocket(url); } catch (e) { this._scheduleReconnect(); return; }
    this.ws = ws;
    /* M5：代际校验——每个连接持有自己的 ws 引用。旧连接的异步 close/error 到达时，
     * this.ws 已被新连接替换，直接忽略，避免误清新心跳、误拒新请求、产生孤儿重连。 */
    const isCurrent = () => this.ws === ws && !this.stopped;

    ws.on('message', (buf) => {
      if (!isCurrent()) return;
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
      this._onMessage(ws, msg);
    });

    ws.on('close', (code, reason) => {
      /* 关闭码是判定"真断连还是我方心跳误杀"的关键证据：
       * 1000/1001=对端正常关闭；1006=无 close 帧（网络中断/超时）；1011=对端异常；
       * 若是我们 terminate（心跳超时），code 同样是 1006，需结合 pongTimer 是否挂起判断。 */
      const byHeartbeat = !!this.pongTimer;
      console.warn(`[ha] ws closed code=${code} reason=${(reason && reason.toString()) || '-'} 心跳超时触发=${byHeartbeat}`);
      if (!isCurrent()) return;
      clearInterval(this.heartbeat);
      this.heartbeat = null;
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
      this.ready = false; // 缓存已陈旧：getState 不再返回旧快照
      this._rejectAll(new Error('HA WebSocket 断开'));
      this._scheduleReconnect();
    });

    ws.on('error', (e) => {
      if (process.env.DEBUG) console.error('[ha] ws error:', e.message);
    });
  }

  _onMessage(ws, msg) {
    if (msg.type === 'auth_required') {
      ws.send(JSON.stringify({ type: 'auth', access_token: this.getConfig().token }));
      return;
    }
    if (msg.type === 'auth_invalid') {
      /* token 无效属终态：置 stopped 阻断重连循环（否则每 3s 无限重试、脚本反复挂起/恢复）。
       * 修复 token 后需手动 restart()/重启服务恢复连接。 */
      this.stopped = true;
      console.error('[ha] 认证被拒绝（token 无效），停止重连；修复 token 后请重启服务或调用 restart()');
      this._setStatus('error');
      this._rejectAll(new Error('HA token 无效'));
      try { ws.close(); } catch (e) {}
      return;
    }
    if (msg.type === 'auth_ok') {
      this._setStatus('connected');
      this.ready = false; // 认证成功但缓存还没回填：脚本此时读状态会得到 null
      this.entities.clear();
      /* 代际校验：重连过程中若旧连接的全量拉取迟到，不得用它覆盖新连接缓存/误报就绪。 */
      const isCurrent = () => this.ws === ws && !this.stopped;
      /* 首选 subscribe_entities（借鉴 ha-3d-home）：一条订阅同时解决
       * 全量快照（resolve 返回 entities 精简格式）与后续增量推送（c/a/r diff），
       * 属性变化是部分 diff，由 _applyEntityDiff 与旧属性合并，天然覆盖属性级推送。
       * 老版本 HA 不支持该指令时才退回 get_states 全量 + subscribe_events 增量，
       * 且二者绝不并发（晚到的旧全量快照会盖掉增量刚更新的实体）。 */
      this._entitySub = true;
      this.send({ type: 'subscribe_entities' }).then((result) => {
        if (!isCurrent()) return;
        if (result && result.entities && typeof result.entities === 'object') {
          for (const [eid, st] of Object.entries(result.entities)) {
            this.entities.set(eid, this._normSnapshot(eid, st, this.entities.get(eid)));
          }
          this.ready = true;   // 缓存新鲜：才允许脚本据此动作
          this.onReady();      // 通知执行器解除断线挂起
        } else {
          /* 响应异常（缺 entities 字段）：不置 ready，转回退通道拉全量 */
          this._entitySub = false;
          this._fallbackSnapshot(ws, isCurrent);
        }
      }).catch(() => {
        if (!isCurrent()) return;
        this._entitySub = false; // 回退通道：此后增量走 state_changed 事件
        this._fallbackSnapshot(ws, isCurrent);
      });
      this.send({ type: 'get_services' }).then((services) => {
        if (isCurrent() && services && typeof services === 'object') this.services = services;
      }).catch(() => {});
      this._startHeartbeat();
      return;
    }
    if (msg.type === 'pong') {
      clearTimeout(this.pongTimer); // 收到心跳回应，重置超时
      this.pongTimer = null;
      if (msg.id != null) {
        const p = this.pending.get(msg.id); // ping 走 send() 带 id，回包同样清 pending + 定时器
        this.pending.delete(msg.id);
        if (p) clearTimeout(p.timer);
      }
      return;
    }
    if (msg.type === 'event' && msg.event) {
      const ev = msg.event;
      /* subscribe_entities 增量通道：{c:{eid:diff}, a:{eid:diff}, r:[eid]}。
       * c=change / a=add 是属性与状态的 diff（可能是 "+" 包装或部分属性），r=remove。 */
      if (this._entitySub && (ev.c || ev.a || ev.r)) {
        this._applyEntityDiff(ev);
        return;
      }
      /* 老版本回退通道：subscribe_events 的 state_changed（完整事件格式） */
      if (ev.event_type === 'state_changed' && ev.data && ev.data.entity_id) {
        const d = ev.data;
        const eid = d.entity_id;
        const prev = this.entities.get(eid) || null;
        const next = d.new_state || null;
        if (next) this.entities.set(eid, next);
        else this.entities.delete(eid);
        this.onStateChange(eid, next, prev);
      }
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.success === false) p.reject(new Error((msg.error && msg.error.message) || 'HA 指令失败'));
      else p.resolve(msg.result);
    }
  }

  /* 老版本 HA 回退通道：先订增量并等订阅确认，再拉全量快照（审计 4.7）。
   * 之前两者并发：订阅确认前的增量先写缓存，随后到达的全量会整体覆盖，
   * 把增量刚更新的实体抹回旧值；串行化后全量是最后落地的完整一致快照。 */
  _fallbackSnapshot(ws, isCurrent) {
    this.send({ type: 'subscribe_events', event_type: 'state_changed' })
      .then(() => {
        if (!isCurrent()) throw new Error('stale-connection');
        return this.send({ type: 'get_states' });
      })
      .then((states) => {
        if (!isCurrent()) return;
        if (Array.isArray(states)) for (const s of states) this.entities.set(s.entity_id, s);
        this.ready = true;
        this.onReady();
      })
      .catch((e) => {
        if (!isCurrent()) return;
        if (e && e.message === 'stale-connection') return;
        /* 拉取/订阅失败视为连接不可用：先关旧 socket 再重连，避免孤儿连接占用。
         * subscribe_events 订阅失败静默吞掉会导致回退通道缓存永久陈旧，必须留痕。 */
        console.error('[ha] 回退通道建立失败（get_states/subscribe_events）：', e && e.message || e, '，重连');
        if (this.ws === ws) { try { ws.close(); } catch (err) {} }
        this._scheduleReconnect();
      });
  }

  /* 全量快照的精简格式归一：{s, a, lc, lu} → 完整 state object（借鉴 ha-3d-home 的 norm）。
   * attributes 无条件与旧属性合并：增量里 a 是部分 diff，整体替换会丢 friendly_name
   * 等未变属性（对齐 ha-3d-home services/ha.js 的合并行为）。 */
  _normSnapshot(eid, st, prev) {
    if (!st || typeof st !== 'object') return { entity_id: eid, state: undefined, attributes: {} };
    const d = st['+'] && typeof st['+'] === 'object' ? st['+'] : st; // diff 包装兼容
    return {
      entity_id: eid,
      state: d.s,
      attributes: { ...((prev && prev.attributes) || {}), ...(d.a || {}) },
      ...(d.lc ? { last_changed: new Date(d.lc * 1000).toISOString() } : {}),
      ...(d.lu ? { last_updated: new Date(d.lu * 1000).toISOString() } : {}),
    };
  }

  /* subscribe_entities 增量合并：diff 合进缓存，再按 prev/next 逐实体通知执行器。
   * 关键点：增量里的 attributes 是部分 diff（甚至只有 "+" 键变更），必须与旧属性
   * 合并，否则 friendly_name / hvac_action 等未变属性会丢。 */
  _applyEntityDiff(ev) {
    const changed = [];
    const apply = (map, isRemove) => {
      if (isRemove) {
        const ids = Array.isArray(map) ? map : Object.keys(map);
        for (const eid of ids) {
          const prev = this.entities.get(eid) || null;
          this.entities.delete(eid);
          changed.push([eid, null, prev]);
        }
        return;
      }
      for (const [eid, st0] of Object.entries(map)) {
        const prev = this.entities.get(eid) || null;
        const st = st0 && st0['+'] && typeof st0['+'] === 'object' ? st0['+'] : st0;
        if (!st || typeof st !== 'object') continue;
        let next;
        if (st.s !== undefined) {
          next = this._normSnapshot(eid, st, prev); // 属性与旧值合并（部分 diff 不丢字段）
        } else {
          /* 状态没动：只有属性 diff / last_updated 等元数据。属性与旧值合并。 */
          if (!st.a && !st.lu && !st.lc) continue; // 纯不可见元数据变化，不通知
          const base = prev || { entity_id: eid, state: undefined, attributes: {} };
          next = { ...base, attributes: st.a ? { ...(base.attributes || {}), ...st.a } : (base.attributes || {}) };
          if (st.lu) next.last_updated = new Date(st.lu * 1000).toISOString();
          if (st.lc) next.last_changed = new Date(st.lc * 1000).toISOString();
        }
        this.entities.set(eid, next);
        changed.push([eid, next, prev]);
      }
    };
    if (ev.c && typeof ev.c === 'object') apply(ev.c, false);
    if (ev.a && typeof ev.a === 'object') apply(ev.a, false);
    if (ev.r) apply(ev.r, true);
    for (const [eid, next, prev] of changed) this.onStateChange(eid, next, prev);
  }

  _startHeartbeat() {
    clearInterval(this.heartbeat);
    clearTimeout(this.pongTimer);
    this.heartbeat = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      /* 半开连接兜底：发出 ping 后若 PONG_TIMEOUT_MS 内没收到 pong（msg.type==='pong'
       * 会清掉 pongTimer），判定链路已死，主动 terminate 触发 close → 重连。
       * 否则 TCP 未断但 HA 无响应时，readyState 一直是 1，永远发现不了假连接。 */
      clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        if (this.ws && this.ws.readyState === 1) {
          try { this.ws.terminate(); } catch (e) {}
        }
      }, PONG_TIMEOUT_MS);
      /* 必须走 send()（自动带 id）：HA 要求除 auth 外所有消息都带 id，
       * 裸发 {type:'ping'} 无 id 时 HA 不回 pong → 12s 后误判链路已死 → 每 45s 断连一次。 */
      try { this.send({ type: 'ping' }).catch(() => {}); } catch (e) {}
    }, HEARTBEAT_MS);
  }

  _scheduleReconnect() {
    this._setStatus('reconnecting');
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._connect(), 3000);
  }

  _rejectAll(err) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  /* 发 HA WS 指令，带 id 匹配与超时 */
  send(payload, timeoutMs = 15000) {
    if (this.demo) return Promise.reject(new Error('演示模式不支持该 WS 指令'));
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('HA WebSocket 未连接'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('HA 指令超时')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ ...payload, id })); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  listEntities(filter = '') {
    const out = [];
    const q = String(filter || '').toLowerCase();
    for (const e of this.entities.values()) {
      if (q && !e.entity_id.toLowerCase().includes(q) && !String(e.attributes?.friendly_name || '').toLowerCase().includes(q)) continue;
      out.push({ entity_id: e.entity_id, state: e.state, attributes: e.attributes || {} });
    }
    return out.sort((a, b) => a.entity_id.localeCompare(b.entity_id));
  }

  getState(eid) {
    /* 断线/未回填时不返回陈旧缓存——否则脚本会基于旧状态误判并下发错误控制。
     * 返回 null，由 executor 转成"HA 不可用"信号，脚本进入挂起而非当作实体消失。 */
    if (!this.isReady()) return null;
    const e = this.entities.get(String(eid || ''));
    return e ? { entity_id: e.entity_id, state: e.state, attributes: e.attributes || {} } : null;
  }

  /* 实体是否当前存在于 HA 缓存（仅就绪时可信）。
   * 与 getState 的区别：这里显式暴露"存在/不存在/不可判定"三态供执行器区分
   * 「实体被删」（要暂停脚本）与「HA 断线」（要挂起等恢复）。 */
  entityStatus(eid) {
    if (!this.isReady()) return 'unknown';
    return this.entities.has(String(eid || '')) ? 'present' : 'missing';
  }

  /* ---------- HA 自动化 / 脚本 / 设备解析（迁移用，全走 WS send） ---------- */
  /* 只从缓存列 entity_id + 关键属性；配置另走 getAutomationConfig（含完整 triggers/actions）。 */
  listAutomations() {
    return this._listDomain('automation.');
  }

  listHaScripts() {
    return this._listDomain('script.');
  }

  _listDomain(prefix) {
    const out = [];
    for (const e of this.entities.values()) {
      if (!e.entity_id || !e.entity_id.startsWith(prefix)) continue;
      const a = e.attributes || {};
      out.push({
        entity_id: e.entity_id,
        state: e.state,
        name: a.friendly_name || '',
        mode: a.mode || undefined,
        last_triggered: a.last_triggered || undefined,
      });
    }
    return out.sort((a, b) => a.entity_id.localeCompare(b.entity_id));
  }

  /* HA WS automation/config 的入参名是 entity_id（不是 automation_id / slug） */
  async getAutomationConfig(entityId) {
    if (!entityId) throw new Error('缺少 entity_id');
    const r = await this.send({ type: 'automation/config', entity_id: String(entityId) });
    return r && r.config ? r.config : r;
  }

  async getScriptConfig(entityId) {
    if (!entityId) throw new Error('缺少 entity_id');
    const r = await this.send({ type: 'script/config', entity_id: String(entityId) });
    return r && r.config ? r.config : r;
  }

  /* 设备/实体注册表：Flode 里很多 action 写的是 device_id 或十六进制内部 id，
   * 迁移时必须解析成真实 entity_id。缓存一份，避免每条自动化都发一次 WS。 */
  async entityRegistry() {
    if (this._registry) return this._registry;
    const r = await this.send({ type: 'config/entity_registry/list' });
    this._registry = Array.isArray(r) ? r : [];
    return this._registry;
  }

  async resolveEntities(ids) {
    const reg = await this.entityRegistry();
    const wanted = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
    const set = new Set(wanted);
    return reg.filter((e) => set.has(e.entity_id) || set.has(e.device_id))
      .map((e) => ({
        entity_id: e.entity_id,
        device_id: e.device_id || undefined,
        name: e.name || e.original_name || '',
        area_id: e.area_id || undefined,
        disabled_by: e.disabled_by || undefined,
      }));
  }

  async historyOf(eid, hours = 24) {
    if (!eid) return {};
    if (this.demo) return { [eid]: [] };
    const start = new Date(Date.now() - Number(hours || 24) * 3600 * 1000).toISOString();
    const r = await this.send({
      type: 'history/history_during_period', entity_ids: [eid],
      start_time: start, minimal_response: true, no_attributes: true,
    });
    return (r && typeof r === 'object') ? r : {};
  }

  /* callService：target 与 service_data 分开传（对齐 home 的口径） */
  async callService(domain, service, data = {}) {
    /* 断线时快速失败，避免调用方等满 15s 超时；执行器会据此跳过写操作并记日志。 */
    if (!this.isReady()) throw new Error('HA 未就绪，写操作跳过');
    const d = { ...(data || {}) };
    const eid = d.entity_id;
    delete d.entity_id;
    const target = eid ? { entity_id: eid } : {};
    if (this.demo) {
      /* demo 语义对齐真实 HA：未知实体/服务返回失败（真实 HA 会报 entity/service not found）；
       * 状态词按域映射（cover 用 open/closed，其余 on/off），避免 demo 验证通过、连真实 HA 行为不同。 */
      const services = this.services || {};
      if (eid && !this.entities.has(eid)) throw new Error(`demo：实体不存在 ${eid}`);
      if (!services[domain] || !(service in services[domain])) {
        throw new Error(`demo：服务不存在 ${domain}.${service}`);
      }
      const prev = eid ? this.getState(eid) : null;
      const OPEN_SVC = new Set(['turn_on', 'open', 'open_cover']);
      const CLOSE_SVC = new Set(['turn_off', 'close', 'close_cover']);
      const domainState = (e) => {
        if (domain === 'cover') {
          if (OPEN_SVC.has(service)) return 'open';
          if (CLOSE_SVC.has(service)) return 'closed';
          return e.state === 'open' ? 'closed' : 'open';
        }
        return OPEN_SVC.has(service) ? 'on' : CLOSE_SVC.has(service) ? 'off' : (e.state === 'on' ? 'off' : 'on');
      };
      if (eid) {
        const e = this.entities.get(eid);
        const next = { ...e, state: domainState(e) };
        this.entities.set(eid, next);
        this.onStateChange(eid, next, e);
      }
      return { demo: true, domain, service, target, service_data: d };
    }
    return this.send({ type: 'call_service', domain, service, target, service_data: d });
  }
}

module.exports = { HaConnector, wsUrl };
