/* ---- ctx.hold：双边迟滞确认器（审计 3.5：从 createCore 闭包抽出为顶层函数）----
 * 原本内嵌在 createCore 里近 200 行，与 ref/watch 挤在同一作用域。闭包依赖显式经
 * deps 注入：emit（日志桥）/ evalRealm（realm 内调用回调）/ makeOff（watch 退订句柄）/
 * cancelTimer / isStopped（停止态只读）/ after（= ctx.after，受 timers 注册表管理，
 * stop 统一清理）/ clk（虚拟或真实时钟）/ signalEquals（期待值等值判定，runner-core 模块级）。
 * 内部状态纯闭包内存，不碰 global/local。 */
function createHold(opts, deps) {
  const { emit, evalRealm, makeOff, cancelTimer, isStopped, after, clk, signalEquals } = deps;
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new Error('ctx.hold 只接受对象参数 { expect, satisfyMs, unsatisfyMs? }');
  }
  const conf = opts;
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  for (const oldKey of ['ms', 'condition', 'fallMs']) {
    if (hasOwn(conf, oldKey)) {
      throw new Error(`ctx.hold 不再支持旧参数 ${oldKey}：请改用 ${oldKey === 'ms' ? 'satisfyMs' : oldKey === 'condition' ? 'expect' : 'unsatisfyMs'}`);
    }
  }
  const satisfyMs = Math.max(0, Number(conf.satisfyMs) || 0);
  if (satisfyMs <= 0) throw new Error('ctx.hold 的满足持续时长 satisfyMs 必须大于 0');

  const unsatisfyRaw = hasOwn(conf, 'unsatisfyMs') ? conf.unsatisfyMs : null;
  const unsatisfyMs = (unsatisfyRaw === null || unsatisfyRaw === undefined || unsatisfyRaw === '')
    ? 0 : Math.max(0, Number(unsatisfyRaw) || 0);

  const initial = conf.initial === undefined ? false : !!conf.initial;
  const expectFn = typeof conf.expect === 'function' ? conf.expect : null;
  const hasExpectValue = !expectFn && hasOwn(conf, 'expect');
  const expectValue = hasExpectValue ? conf.expect : undefined;
  const nodeId = conf.nodeId;
  const label = conf.label ? `[hold·${conf.label}] ` : '[hold] ';
  const log = (message, level = 'info') =>
    emit({ type: 'log', level, message: label + message, nodeId });
  /* 日志文案中文化：只翻显示用的方向/触发标记，info.reason、state().pending 等字段值仍是英文。 */
  const dirCn = (v) => v === 'satisfied' ? '满足' : v === 'unsatisfied' ? '回落' : String(v);
  const trigCn = (v) => String(v).split(':').map((p) => ({
    init: '初始化', assign: '赋值', timer: '到点', retry: '重试', resume: '补排',
  }[p] || dirCn(p))).join('·');

  let raw = initial;
  let state = initial;   // 当前已确认状态：true=已确认满足期待，false=未满足/已回落
  let stable = state;    // 兼容旧 state()/文档：与 state 同步，不再作为 watch 触发条件
  let desired = false;   // 最近一次 expect 投影结果：是否满足期待
  let pending = null;    // 'satisfied' / 'unsatisfied' / null
  let since = 0;         // 当前等待方向开始持续的起点；0 = 未计时
  let timer = null;      // ctx.after 句柄（受 timers 注册表管理，stop 统一清理）
  let seq = 0;           // 重评序号：异步 expect 期间被新一次重评抢占则放弃旧结果
  let dead = false;
  const watchers = new Set();
  const clearHoldTimer = () => { if (timer) { cancelTimer(timer); timer = null; } };
  const delayFor = (direction) => direction === 'satisfied' ? satisfyMs : unsatisfyMs;

  const notify = (trigger, waitedMs) => {
    const prev = state;
    state = desired;
    stable = state;
    pending = null;
    since = 0;
    const reason = state ? 'satisfied' : 'unsatisfied';
    log(`确认${state ? '满足' : '不满足'}：状态 ${String(prev)} → ${String(state)}` +
      `（持续 ${waitedMs}ms，触发=${trigCn(trigger)}）`);
    const info = {
      satisfied: state,
      value: state,
      reason,
      raw,
      expected: desired,
      state,
      stable,
      ms: waitedMs,
      nodeId,
    };
    for (const cb of [...watchers]) {
      evalRealm(cb, [state, prev, info]).catch((e) =>
        log(`watcher 异常：${e && e.message || e}`, 'error'));
    }
  };

  /* 统一到点排程：回调先确认自己仍是当前 timer 再处理（过期回调直接丢弃），
   * 句柄清理也收在这里。到点复核抛异常时保留 pending/since，由异常路径补排重试。 */
  const arm = (delay, trigger) => {
    const id = after(delay, () => {
      if (timer !== id) return;
      timer = null;
      reevaluate(trigger);
    });
    /* 给虚拟时钟的定时器打标签：快照 timers[] 展示「满足计时/回落计时」，
     * 让 AI 一眼看出脚本此刻在等什么（§7.6）。follow 模式 label 是 no-op。 */
    if (clk.isVirtual && typeof clk.label === 'function') {
      clk.label(id, `${conf.label || 'hold'}·${dirCn(pending || 'satisfied')}计时`);
    }
    timer = id;
  };
  /* 异常重试/句柄补排的间隔：到点后剩余时间为 0 时给 50ms 下限，
   * 避免 expect 连续抛错形成 0ms 紧循环刷日志。 */
  const retryDelay = () => {
    if (!pending) return satisfyMs;
    const delay = delayFor(pending);
    return since > 0 ? Math.max(50, delay - (clk.now() - since)) : Math.max(50, delay);
  };

  async function reevaluate(trigger) {
    if (dead || isStopped()) return;
    const my = ++seq;
    /* 1) 投影 desired：expect 可同步可 async，可自行 await ctx.ha 读实体；
     *    抛错则保守跳过、不推进计时，但必须补排重试。 */
    let next;
    if (expectFn) {
      try { next = !!(await evalRealm(expectFn, [raw])); }
      catch (e) {
        log(`expect 异常，本轮跳过：${e && e.message || e}`, 'error');
        if (my === seq && !dead && !isStopped() && !timer) arm(retryDelay(), 'retry');
        return;
      }
    } else if (hasExpectValue) {
      next = signalEquals(raw, expectValue); // 期待值模式：raw 等于 expect 才算满足
    } else {
      next = !!raw;                          // 默认期待值：truthy 即满足，兼容 a.value=true/'Busy'
    }
    if (my !== seq || dead || isStopped()) return;
    desired = next;

    /* 2) 期待结果与当前已确认状态一致：没有待确认边沿，取消本轮计时，不回调。 */
    if (desired === state) {
      if (pending) log(`期待回到已确认状态 ${String(desired)}，取消${dirCn(pending)}计时`);
      pending = null;
      since = 0;
      clearHoldTimer();
      return;
    }

    /* 3) 期待结果与当前状态相反：按方向计时；中途回到当前状态则上一步会取消。 */
    const direction = desired ? 'satisfied' : 'unsatisfied';
    const delay = delayFor(direction);
    if (pending !== direction) {
      pending = direction;
      since = clk.now();
      clearHoldTimer();
      log(`期待${desired ? '满足' : '不满足'}，${dirCn(direction)}计时 ${delay}ms（触发=${trigCn(trigger)}）`);
      if (delay === 0) { notify(trigger + ':立即', 0); return; }
      arm(delay, trigger);
      return;
    }

    /* 4) 同方向已计时：到点复核仍成立就切换状态并通知一次；句柄丢失则按剩余时间补排。 */
    if (since > 0 && clk.now() - since >= delay) {
      const waitedMs = clk.now() - since;
      clearHoldTimer();
      notify(trigger, waitedMs);
      return;
    }
    if (since > 0 && !timer) arm(Math.max(1, delay - (clk.now() - since)), 'resume');
  }

  const handle = {
    get value() { return state; },
    set value(nv) {
      if (dead) return;
      raw = nv;
      reevaluate('assign');
    },
    watch(cb) {
      if (typeof cb !== 'function') throw new Error('hold.watch 需要回调函数');
      if (dead) return () => false;
      watchers.add(cb);
      return makeOff(watchers, cb);
    },
    cancel() {
      if (dead) return false;
      dead = true;
      seq++;
      clearHoldTimer();
      pending = null;
      since = 0;
      watchers.clear();
      return true;
    },
    state() {
      const active = pending !== null;
      return {
        raw, desired, signal: desired, state, stable: state,
        pending,
        since,
        active,
        remaining: active ? Math.max(0, delayFor(pending) - (clk.now() - since)) : 0,
        ms: satisfyMs,
        satisfyMs,
        unsatisfyMs,
        dead,
      };
    },
  };
  reevaluate('init'); // 首次投影：让初始实体值/expect 立即进入判定
  return handle;
}

module.exports = { createHold };
