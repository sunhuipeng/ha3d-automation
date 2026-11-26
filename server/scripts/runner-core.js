'use strict';
/* runner-core：脚本执行核心（S2 realm 沙箱 + ctx 注入 + 框架 API + 受控定时器）。
 * 三种宿主共用同一套执行语义与消息协议，脚本侧 API 完全一致：
 *   fork    — runner.js 子进程入口：emit 走 IPC；卡死由进程隔离兜底（默认，隔离最硬）。
 *   inline  — inline-runner.js 在主进程内执行（EXECUTION_MODE=inprocess）：
 *             单进程省内存；脚本回调经 vm timeout 防同步死循环卡死主进程。
 *   worker  — worker-runner.js 线程入口（EXECUTION_MODE=worker）：
 *             OS 抢占式公平调度 + terminate 强杀异步续体，内存居中。
 *
 * 消息协议：
 *   core → 宿主 : { log | subscribe | contextSubscribe | contextUnsubscribe | taskSubscribe | taskUnsubscribe | request | done }
 *   宿主 → core : { run | reply | state | contextChange | taskState | mode | suspend | resume | stop }
 *
 * 安全边界：AST 白名单（提交时校验）+ realm 沙箱（切断宿主逃逸链）+
 * 脚本层 ctx.write 写闸（影子 / 开发模式）+ 主进程 executor 硬拦截。 */
const vm = require('vm');
const { shadowWrite, devWrite } = require('./log-text');

/* 脚本回调（订阅/定时器）同步部分的上限：inline 模式的关键安全措施，
 * 同步死循环会被 V8 timeout 中断，宿主最多卡这段时间而不是永远。
 * 可用 meta.cbTimeoutMs 覆盖（测试加速用）。 */
const CB_TIMEOUT_MS = 2000;

function createCore({ emit }) {
  /* emit(msg)：宿主桥。fork 宿主 = process.send；inline 宿主 = EventEmitter。 */
  let script = '';
  let meta = {};
  let cbTimeoutMs = CB_TIMEOUT_MS;
  let vmCtx = null;               // 当前脚本的 vm context（guarded 回调用）
  /* 运行模式/挂起/停止：由主进程通过 mode/suspend/resume/stop 消息热更新。
   * devMode 由 executor 随 run 注入（全局开发模式），与 dryRun 正交：
   * dryRun=脚本通道身份，devMode=环境写拦截；发布热切只改 dryRun，不改 devMode。 */
  const ctxRuntime = { dryRun: true, devMode: false, stopped: false, suspended: false, suspendReason: null };
  const subscriptions = new Map(); // entityId -> [cb]
  const globalSubs = new Map();    // ctx.global.watch：key -> Set<cb>（返回取消订阅函数）
  const taskSubs = new Map();      // ctx.watch.task：scriptId -> Set<cb>（返回取消订阅函数）
  const taskWaiters = new Map();   // ctx.task.require：scriptId -> Set<{resolve,timer}>（状态变化提前唤醒）
  const timers = new Map();        // ctx.after 定时器：id -> timeout（stop 时统一清理）
  const intervals = new Set();     // sandbox.setInterval 建立的循环定时器（stop 时统一 clear）
  let timerSeq = 0;
  /* 同步等待宿主回执（getState 这类要返回值的调用） */
  const waiting = new Map();
  let waitSeq = 0;

  function request(action, data, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const id = ++waitSeq;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('runner 请求超时：' + action)); }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      emit({ type: 'request', id, action, data });
    });
  }

  function resolveReply(msg) {
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    clearTimeout(w.timer);
    if (msg.ok) w.resolve(msg.result); else w.reject(new Error(msg.error || '主进程请求失败'));
  }

  /* ctx.task.require 的等待门闩：任务状态变化（host 下发 taskState）时提前唤醒，
   * 未变化则由短超时兜底轮询（防止订阅与状态变更之间的竞态窗口）。 */
  function waitTaskChange(sid, ms) {
    return new Promise((resolve) => {
      let set = taskWaiters.get(sid);
      if (!set) { set = new Set(); taskWaiters.set(sid, set); }
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        set.delete(entry);
        if (!set.size) taskWaiters.delete(sid);
        resolve();
      }, Math.max(0, ms));
      set.add(entry);
    });
  }
  function notifyTaskWaiters(sid) {
    const set = taskWaiters.get(sid);
    if (!set) return;
    for (const entry of [...set]) {
      clearTimeout(entry.timer);
      set.delete(entry);
      entry.resolve();
    }
    taskWaiters.delete(sid);
  }
  function clearTaskWaiters() {
    for (const set of taskWaiters.values()) {
      for (const entry of set) { clearTimeout(entry.timer); entry.resolve(); }
    }
    taskWaiters.clear();
  }

  /* 受控回调：同步死循环被 V8 timeout 中断；async 返回值挂 reject，
   * 不让 unhandledRejection 漏进宿主（fork 侧防崩溃重启风暴，inline 侧防主进程被打）。 */
  function guardedCall(fn, args) {
    try {
      vmCtx.__guardFn = fn;
      vmCtx.__guardArgs = args || [];
      const r = vm.runInContext('__guardFn(...__guardArgs)', vmCtx, { timeout: cbTimeoutMs });
      if (r && typeof r.catch === 'function') {
        r.catch((e) => emit({ type: 'log', level: 'error', message: '异步回调异常：' + (e && e.message || e) }));
      }
    } catch (e) {
      emit({ type: 'log', level: 'error', message: '回调执行被中断（同步超时/异常）：' + (e && e.message || e) });
    }
  }

  /* ---------------- 沙箱构造（S2 运行层加固）----------------
   * 只把 realm 内对象暴露给脚本：vm context 自带 realm 的 Math/Date/JSON/Promise 等内建，
   * 不再注入宿主版本；ctx/console/timers 这些必须桥接宿主能力的函数，全部转成 realm 内
   * 函数——脚本拿到的是 realm 内函数，其 .constructor 指向 realm Function，拿不到宿主
   * process。宿主实现只存在于 invoke 闭包中，脚本无法访问。
   * 注意：属性遍历在宿主侧做（realm 内 Object.keys 看宿主对象是空的），只把单个函数/值
   * 交给 realm 工厂包装。静态校验已拦 .constructor/.__proto__ 链，这里是第二道纵深。 */
  function buildSandbox() {
    const sandbox = {};
    const context = vm.createContext(sandbox);
    const factory = vm.runInContext(`(invoke) => {
      return {
        makeObject: function () { return {}; },
        wrapFn: function (hostFn) {
          return function (...a) { return invoke(hostFn, a); };
        },
        makePromise: function (executor) { return new Promise(function (res, rej) { executor(res, rej); }); },
        makeError: function (message) { return new Error(message); }
      };
    }`, context);
    const memo = new WeakMap();
    /* 宿主桥：调用宿主函数后，把结果（含 Promise 的 resolve 值）conv 成 realm 安全值，
     * 再用 realm 的 Promise 承载。脚本自始至终拿不到任何宿主对象/函数。 */
    const invoke = (fn, args) => {
      let r;
      try { r = fn(...args); } catch (err) { throw conv(err); } // 同步异常同样 conv：宿主 Error 不得跨 realm
      if (r && typeof r.then === 'function') {
        return tools.makePromise((resolve, reject) => {
          r.then((val) => resolve(conv(val)), (err) => reject(conv(err)));
        });
      }
      return conv(r);
    };
    const tools = factory(invoke);

    function conv(v, depth = 0) {
      if (v == null) return v;
      if (depth > 12) return null; // 超深嵌套截断为 null——绝不能把宿主对象原样交给脚本（realm 逃逸）
      const t = typeof v;
      if (t === 'function') {
        if (memo.has(v)) return memo.get(v);
        const w = tools.wrapFn(v);
        memo.set(v, w);
        /* 函数上的可枚举子接口（ctx.watch.task）必须一并搬进 realm：
         * wrapFn 只返回裸函数，不复制自身属性，脚本里会读不到 ctx.watch.task。 */
        for (const k of Object.keys(v)) {
          const d = Object.getOwnPropertyDescriptor(v, k);
          if (d && typeof d.get === 'function') {
            Object.defineProperty(w, k, { get: () => conv(d.get.call(v), depth + 1), enumerable: true });
          } else {
            w[k] = conv(v[k], depth + 1);
          }
        }
        return w;
      }
      if (t !== 'object') return v;
      if (memo.has(v)) return memo.get(v);
      /* Error 的 message/stack 是非枚举属性，Object.keys 拿不到；转成 realm Error 保留 message */
      if (v instanceof Error) {
        const e = tools.makeError(String(v.message || v));
        memo.set(v, e);
        return e;
      }
      const out = tools.makeObject(); // realm 内对象
      memo.set(v, out);
      for (const k of Object.keys(v)) {
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (d && typeof d.get === 'function') {
          Object.defineProperty(out, k, { get: () => conv(d.get.call(v), depth + 1), enumerable: true });
        } else {
          out[k] = conv(v[k], depth + 1);
        }
      }
      return out;
    }
    return { sandbox, context, conv };
  }

  function contextApi(scope) {
    const api = {
      get: (key, fallback) => request('contextGet', { scope, key, default: fallback }),
      set: (key, value) => request('contextSet', { scope, key, value }),
    };
    /* ctx.global.watch(key, cb)：只订阅 global；local 是脚本私有桶，没有跨脚本变更源。
     * 回调签名 (value, prev, info)，info = { key, writerSid, namespace }。
     * 读侧统一 production 命名空间，写侧仍按调用者模式隔离；过滤由主进程执行器负责。 */
    if (scope === 'global') {
      api.watch = (key, cb) => {
        const k = String(key == null ? '' : key);
        if (!k || typeof cb !== 'function') throw new Error('ctx.global.watch 需要 key 与回调函数');
        let set = globalSubs.get(k);
        if (!set) { set = new Set(); globalSubs.set(k, set); }
        const first = set.size === 0;
        set.add(cb);
        if (first) emit({ type: 'contextSubscribe', scope: 'global', key: k });
        let active = true;
        return () => {
          if (!active) return false;
          active = false;
          set.delete(cb);
          if (!set.size) {
            globalSubs.delete(k);
            emit({ type: 'contextUnsubscribe', scope: 'global', key: k });
          }
          return true;
        };
      };
    }
    return api;
  }

  async function run() {
    ctxRuntime.dryRun = meta.dryRun !== false;
    ctxRuntime.devMode = meta.devMode === true;
    cbTimeoutMs = Math.max(50, Number(meta.cbTimeoutMs) || CB_TIMEOUT_MS);

    /* ---------------- 框架层通用能力 ----------------
     * 只放“每个脚本都会重复写一遍、且与业务无关”的样板；
     * 判据（阈值、模式识别）和具体动作语义必须留在脚本里。 */
    /* ctx.task：查询/等待其他脚本实例状态。状态裁决（只看依赖的**正式实例**，影子实例
     * 不参与——mode 恒 production、读不隔离）全在主进程 executor 完成，脚本侧只消费结果，
     * 避免各处重复实现通道规则。 */
    const taskStatus = (id) => request('taskStatus', { scriptId: String(id == null ? '' : id) });
    const taskRequire = async (id, opts = {}) => {
      const sid = String(id == null ? '' : id);
      if (!sid) throw new Error('ctx.task.require 需要脚本 id');
      const raw = Number(opts && opts.timeout);
      const timeoutMs = opts && opts.timeout !== undefined && Number.isFinite(raw) && raw >= 0 ? raw : 30000;
      const deadline = Date.now() + timeoutMs;
      let last = null;
      for (;;) {
        if (ctxRuntime.stopped) throw new Error(`脚本已停止，取消等待依赖 ${sid}`);
        last = await request('taskStatus', { scriptId: sid });
        if (last && last.state === 'running') return last; // 一次性门闩：首次 running 后不再阻断
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`等待依赖脚本 ${sid} 超时（${timeoutMs}ms，当前状态：${last && last.state || 'unknown'}）`);
        await waitTaskChange(sid, Math.min(200, left));
      }
    };

    const ctx = {
      scriptId: String(meta.sid || meta.id || ''),
      global: contextApi('global'),
      local: contextApi('local'),
      ha: {
        getState: (eid) => request('getState', { entityId: eid }),
        listEntities: (filter) => request('listEntities', { filter }),
        callService: (domain, service, data) => request('callService', { domain, service, data }),
        onStateChange: (entityId, cb) => {
          const key = String(entityId || '');
          if (!subscriptions.has(key)) subscriptions.set(key, []);
          subscriptions.get(key).push(cb);
          emit({ type: 'subscribe', entityId: key });
        },
        subscribe: (condition, cb) => {
          // condition 为 entityId 字符串或 {entityId}；条件（entityId 匹配）在注册时已确定，
          // 每次状态变化都会调用 cb（不是只调一次），需要"只触发一次"请在 cb 里自行注销判断。
          const eid = typeof condition === 'string' ? condition : (condition && condition.entityId);
          if (eid) {
            ctx.ha.onStateChange(eid, (s, prev) => {
              try { cb(s, prev); } catch (e) { emit({ type: 'log', level: 'error', message: 'subscribe 回调异常：' + (e && e.message || e) }); }
            });
          }
        },
      },
      log: (level, message, nodeId) => emit({ type: 'log', level: String(level || 'info'), message: String(message), nodeId: nodeId ? String(nodeId) : undefined }),
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0))),
      /* 被 ctx.call 触发时携带的入参（主进程注入 meta.callParams）；未被调用时为 null。
       * 由 buildSandbox 的 conv 转成 realm 安全对象，脚本拿不到宿主对象。 */
      params: meta.callParams === undefined ? null : meta.callParams,
      /* 依赖脚本状态：status 查一次；require 一直等到 running（默认 30s 超时）。
       * 返回 { scriptId, version, mode, state, info }；重启抖动由业务侧用防抖兜底。 */
      task: { status: taskStatus, require: taskRequire },
      /* 显式联动：触发另一个脚本/场景的正式或影子版本（跟随调用者模式）。
       * 只等"启动回执"，不等被调脚本跑完；目标类型/防重入/防递归全在主进程执行器裁决。 */
      call: (scriptId, params) => {
        let payload;
        try { payload = params === undefined ? undefined : JSON.parse(JSON.stringify(params)); }
        catch (e) { throw new Error('ctx.call 的 params 必须可 JSON 序列化'); }
        return request('callScript', { scriptId: String(scriptId == null ? '' : scriptId), params: payload });
      },
    };

    /* 动作注册表：业务动作仍由脚本定义，框架只负责“影子拦截 + 日志 + 计数” */
    const actionRegistry = new Map();
    const writeStats = { intent: 0, sent: 0, blocked: 0 };

    ctx.actions = (table) => {
      if (!table || typeof table !== 'object') throw new Error('ctx.actions 需要传入 { name: () => {...} } 对象');
      for (const [name, fn] of Object.entries(table)) {
        if (typeof fn !== 'function') throw new Error(`ctx.actions.${name} 必须是函数`);
        if (actionRegistry.has(name)) throw new Error(`动作重复注册：${name}`);
        actionRegistry.set(name, fn);
      }
    };

    /* ctx.write 是唯一推荐的写入口：影子模式或全局开发模式下只记日志、绝不调用动作。
     * 签名 write(op, desc, nodeId, ...args) 与脚本里原来的本地 write 完全一致。
     * 注意：主进程的硬拦截仍然保留，这里是脚本层的第一道闸，两者都要。 */
    ctx.write = async (op, desc, nodeId, ...args) => {
      const fn = actionRegistry.get(op);
      if (!fn) throw new Error(`未注册的动作：${op}（先调用 ctx.actions({...})）`);
      writeStats.intent += 1;
      /* 兜底：脚本被挂起（HA 断线 / 依赖实体缺失）时不执行任何动作，只记日志。 */
      if (ctxRuntime.suspended) {
        writeStats.blocked += 1;
        emit({ type: 'log', level: 'warn', message: `[兜底] 动作已跳过（${ctxRuntime.suspendReason}）：${desc}`, nodeId });
        return false;
      }
      if (ctxRuntime.dryRun !== false) {
        writeStats.blocked += 1;
        emit({ type: 'log', level: 'warn', message: shadowWrite(desc, op), nodeId });
        return false;
      }
      /* 开发模式：正式通道实例也只记日志不下发（身份仍是正式，上下文仍写正式桶）。 */
      if (ctxRuntime.devMode) {
        writeStats.blocked += 1;
        emit({ type: 'log', level: 'warn', message: devWrite(desc, op), nodeId });
        return false;
      }
      await fn(...args);
      writeStats.sent += 1;
      emit({ type: 'log', level: 'warn', message: `[真实写操作] ${desc}（action.${op}）`, nodeId });
      return true;
    };

    ctx.stats = () => ({ ...writeStats });
    ctx.num = (v) => { const x = Number(v); return Number.isNaN(x) ? 0 : x; };

    /* 读取实体状态的薄封装：state 只要字符串，num 直接转数字（实体不存在时可指定 fallback） */
    const readState = (eid) => request('getState', { entityId: eid });
    ctx.ha.state = async (eid) => { const s = await readState(eid); return s ? s.state : null; };
    ctx.ha.num = async (eid, fallback = 0) => { const s = await readState(eid); return s ? ctx.num(s.state) : fallback; };
    /* 读取实体属性：空调 hvac_action、input_datetime.timestamp 等触发判据在属性里 */
    ctx.ha.getAttribute = async (eid, attr, fallback = null) => {
      const s = await readState(eid);
      if (!s || !s.attributes) return fallback;
      const v = s.attributes[String(attr)];
      return v === undefined || v === null ? fallback : v;
    };

    /* 防重入：默认单锁；传 key 可开多把独立锁。上一次未结束则直接返回 false */
    const locks = new Set();
    ctx.lock = async (keyOrFn, maybeFn) => {
      const key = typeof keyOrFn === 'string' ? keyOrFn : 'default';
      const fn = typeof keyOrFn === 'function' ? keyOrFn : maybeFn;
      if (typeof fn !== 'function') throw new Error('ctx.lock 需要回调函数');
      if (locks.has(key)) return false;
      locks.add(key);
      try { await fn(); return true; } finally { locks.delete(key); }
    };

    /* 批量订阅实体变化（转发 onStateChange，签名一致） */
    ctx.watch = (entityIds, cb) => {
      const list = Array.isArray(entityIds) ? entityIds : [entityIds];
      for (const eid of list) if (eid) ctx.ha.onStateChange(eid, cb);
    };
    /* ctx.watch.task(scriptId, cb)：订阅另一个脚本的运行状态（软通知，业务侧自行兜底重启抖动）。
     * 回调签名 (state, info)，info = { scriptId, version, mode, reason }；
     * 注册时主进程立即回放当前状态；返回 off() 取消订阅。 */
    ctx.watch.task = (scriptId, cb) => {
      const sid = String(scriptId == null ? '' : scriptId);
      if (!sid || typeof cb !== 'function') throw new Error('ctx.watch.task 需要脚本 id 与回调函数');
      let set = taskSubs.get(sid);
      if (!set) { set = new Set(); taskSubs.set(sid, set); }
      const first = set.size === 0;
      set.add(cb);
      if (first) emit({ type: 'taskSubscribe', scriptId: sid });
      let active = true;
      return () => {
        if (!active) return false;
        active = false;
        set.delete(cb);
        if (!set.size) {
          taskSubs.delete(sid);
          emit({ type: 'taskUnsubscribe', scriptId: sid });
        }
        return true;
      };
    };

    /* 时间工具：sod = 当日秒数，与 HA input_datetime 的 timestamp 属性同口径 */
    const pad2 = (x) => String(x).padStart(2, '0');
    const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    ctx.time = {
      today: () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; },
      nowSod: () => { const d = new Date(); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); },
      weekday: () => WD[new Date().getDay()],
      nowISO: () => new Date().toISOString(),
      formatSod: (sod) => {
        const n = Math.max(0, Math.floor(Number(sod) || 0));
        return `${pad2(Math.floor(n / 3600))}:${pad2(Math.floor((n % 3600) / 60))}:${pad2(n % 60)}`;
      },
    };

    /* 可取消延时：对应 HA 的 mode:restart / for: 语义。stop 时统一 clear 防止退出后回调乱跑。 */
    ctx.after = (ms, fn) => {
      const id = ++timerSeq;
      const t = setTimeout(() => {
        timers.delete(id);
        guardedCall(fn, []);
      }, Math.max(0, Number(ms) || 0));
      timers.set(id, t);
      return id;
    };
    ctx.cancel = (id) => {
      if (!timers.has(id)) return false;
      clearTimeout(timers.get(id));
      timers.delete(id);
      return true;
    };

    /* 语义化周期定时：受控 setInterval —— 与 ctx.after 共用 timers 注册表（stop 统一清理、
     * ctx.cancel(id) 可停止）；stopped 后自动注销且不再触发；回调走 guardedCall 防同步死循环。
     * 到点触发优先 ctx.after 一次性重排（无漂移累积）；every 只用于固定频率兜底/清理。 */
    ctx.every = (ms, fn) => {
      const period = Math.max(0, Number(ms) || 0);
      const id = ++timerSeq;
      const t = setInterval(() => {
        if (ctxRuntime.stopped) { clearInterval(t); timers.delete(id); return; }
        guardedCall(fn, []);
      }, period);
      timers.set(id, t);
      return id;
    };

    /* 常驻模式锚点：脚本结尾 await ctx.keepAlive() 让顶层协程永不 resolve，
     * runner 不 emit done、executor 不 cleanup —— 长驻守护脚本的标准结尾。
     * 语义等价于裸 await new Promise(() => {})，但自解释且留一条日志；
     * 一次性任务脚本不调用它，顶层自然结束即正常退出路径。 */
    ctx.keepAlive = () => {
      emit({ type: 'log', level: 'info', message: '脚本进入常驻模式（keepAlive），等待实体推送与定时器' });
      return new Promise(() => {});
    };

    /* 动态 getter：脚本每次读 ctx.dryRun / ctx.stopped / ctx.suspended 都拿当前值，不重启热切换 */
    Object.defineProperty(ctx, 'dryRun', { get: () => ctxRuntime.dryRun, enumerable: true });
    Object.defineProperty(ctx, 'stopped', { get: () => ctxRuntime.stopped, enumerable: true });
    Object.defineProperty(ctx, 'suspended', { get: () => ctxRuntime.suspended, enumerable: true });

    emit({ type: 'log', level: 'info', message: `runner 启动 v${meta.version || '?'}｜模式=${ctxRuntime.dryRun ? '影子' : '正式'}` });
    try {
      const { sandbox, context, conv } = buildSandbox();
      vmCtx = context;
      sandbox.ctx = conv(ctx);
      sandbox.console = conv({
        log: (...a) => emit({ type: 'log', level: 'info', message: a.map(String).join(' ') }),
        error: (...a) => emit({ type: 'log', level: 'error', message: a.map(String).join(' ') }),
      });
      /* 裸 setTimeout 同样收编到 timers 注册表：stop 时统一清理（否则脚本让步退出后
       * 定时器回调仍会执行，成为唯一残留源）；回调走 guardedCall + stopped 检查。
       * 脚本层语义仍与原生 setTimeout 一致（返回 id 传给 clearTimeout 可取消）。 */
      sandbox.setTimeout = conv((fn, ms, ...rest) => {
        const id = ++timerSeq;
        const t = setTimeout(() => {
          timers.delete(id);
          if (ctxRuntime.stopped) return;
          guardedCall(fn, rest);
        }, Math.max(0, Number(ms) || 0));
        timers.set(id, t);
        return id;
      });
      /* setTimeout 返回的是自定义序号（宿主句柄存在 timers 注册表），取消必须先查表
       * 拿到宿主句柄再 clearTimeout——直接 clearTimeout(序号) 是 no-op，取消会静默失效
       * （序号被当成普通数字忽略），回调到期仍执行且 stop 兜底清理扫不到（审计 2026-11-26 P0-1）。 */
      sandbox.clearTimeout = conv((id) => {
        const t = timers.get(id);
        if (t) { clearTimeout(t); timers.delete(id); }
        return true;
      });
      /* setInterval 不直接暴露宿主版本：登记到 intervals 便于 stop 统一清理，
       * 且 stopped 后不再触发回调；回调走 guardedCall 防同步死循环。 */
      sandbox.setInterval = conv((fn, ms, ...rest) => {
        const id = setInterval(() => {
          if (ctxRuntime.stopped) return;
          guardedCall(fn, rest);
        }, Math.max(0, Number(ms) || 0));
        intervals.add(id);
        return id;
      });
      sandbox.clearInterval = conv((id) => { clearInterval(id); intervals.delete(id); return true; });

      /* M10：vm 执行超时从 meta.vmTimeoutMs（主进程按 runnerTimeoutMs 减差值派生）读取 */
      const vmTimeout = Number(meta.vmTimeoutMs) >= 1000 ? Number(meta.vmTimeoutMs) : 55000;
      const wrapped = `(async () => {\n${script}\n})()`;
      const result = vm.runInContext(wrapped, context, { timeout: vmTimeout, filename: 'script.js' });
      await Promise.resolve(result);
      emit({ type: 'log', level: 'info', message: '脚本执行完成' });
      emit({ type: 'done', ok: true });
    } catch (e) {
      emit({ type: 'log', level: 'error', message: '脚本异常：' + (e && e.message || e) });
      emit({ type: 'done', ok: false, error: String(e && e.message || e) });
    }
  }

  function dispatchState(eid, state, prev) {
    const key = String(eid || '');
    const cbs = subscriptions.get(key) || [];
    /* 回调签名固定为 (nextObj, prevObj) 完整状态对象，与 ctx.ha.state() 返回字符串不同（契约 §6）。
     * 脚本若要字符串需自行取 s.state，避免误用 s === 'on' 静默失效。
     * guardedCall：同步死循环被 V8 timeout 中断（inline 模式防主进程被卡死的关键）。 */
    for (const cb of cbs) guardedCall(cb, [state, prev]);
  }

  function dispatchGlobalChange(msg) {
    if (msg.scope !== 'global') return;
    const key = String(msg.key || '');
    const cbs = [...(globalSubs.get(key) || [])];
    const info = { key, writerSid: msg.writerSid || '', namespace: msg.namespace || '' };
    for (const cb of cbs) guardedCall(cb, [msg.value, msg.prev, info]);
  }

  function dispatchTaskState(msg) {
    const sid = String(msg.scriptId || '');
    const state = String(msg.state || 'stopped');
    const info = msg.info || {};
    for (const cb of [...(taskSubs.get(sid) || [])]) guardedCall(cb, [state, info]);
    notifyTaskWaiters(sid);
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'run':
        script = msg.script || '';
        meta = msg.meta || {};
        run();
        return;
      case 'reply':
        resolveReply(msg);
        return;
      case 'state':
        dispatchState(msg.entityId, msg.state, msg.prev);
        return;
      case 'contextChange':
        dispatchGlobalChange(msg);
        return;
      case 'taskState':
        dispatchTaskState(msg);
        return;
      case 'mode':
        /* 只切换通道身份（dryRun），devMode 是环境属性、发布热切不改变它。 */
        ctxRuntime.dryRun = msg.dryRun !== false;
        emit({
          type: 'log', level: 'warn',
          message: ctxRuntime.dryRun
            ? '⚙ 运行模式切换：影子模式（所有写操作仅记日志）'
            : (ctxRuntime.devMode
              ? '⚙ 运行模式切换：正式通道（开发模式下写操作仍仅记日志）'
              : '⚙ 运行模式切换：正式模式（将真实下发控制）'),
        });
        return;
      /* 兜底挂起/恢复：由主进程在 HA 断线或依赖实体被删时下发。
       * 脚本层 ctx.write 会读 suspended 标志跳过动作；主进程的 HA 写门控是第二道闸。 */
      case 'suspend':
        ctxRuntime.suspended = true;
        ctxRuntime.suspendReason = msg.reason || 'unknown';
        return;
      case 'resume':
        ctxRuntime.suspended = false;
        ctxRuntime.suspendReason = null;
        return;
      case 'stop': {
        ctxRuntime.stopped = true;
        cleanupLocal(); // 订阅/等待者/定时器统一清（与 destroy 同一套，stop 多一条日志）
        emit({ type: 'log', level: 'info', message: '收到停止指令，等待脚本让步退出' });
        /* 不强杀执行流：让长驻脚本在 sleep / 回调后检查 ctx.stopped() 自行让步退出；
         * 主进程延迟宽限期后会 child.kill() 兜底。 */
        return;
      }
      default:
        return;
    }
  }

  /* stop 的清理体（不含日志）：订阅只对活实例有效、定时器退出后不得再触发写操作。 */
  function cleanupLocal() {
    globalSubs.clear();
    taskSubs.clear();
    clearTaskWaiters(); // 唤醒 require 的 await，让它检查 stopped 后自行让步退出
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    for (const id of intervals) clearInterval(id);
    intervals.clear();
    /* 会话模型（热池）必须项：拒绝仍在等待宿主回执的请求，防止泄漏定时器与悬挂 Promise */
    for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(new Error('实例已结束')); }
    waiting.clear();
  }

  /* 会话终结钩子（热池专用）：session done/被杀后由宿主调用，彻底回收本会话全部
   * 资源——定时器、订阅、等待者、运行时标志。runner-core 的每会话状态全部收敛在
   * createCore 闭包里，destroy 后实例不再被引用即可回收（结构性零跨会话残留）。 */
  function destroy() {
    ctxRuntime.stopped = true;
    cleanupLocal();
  }

  return { handleMessage, isStopped: () => ctxRuntime.stopped, destroy };
}

module.exports = { createCore };
