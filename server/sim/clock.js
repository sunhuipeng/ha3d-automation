'use strict';
/* 虚拟时钟：由 advance 驱动的定时器堆，供 simulate 会话使用。
 *
 * 口径：startAt 用 ISO（如 2026-11-26T20:29:55+08:00）或 epoch/Date 解析，
 * now() = 起始 epoch + 已推进的虚拟毫秒；date() 返回 new Date(now())，
 * 与项目 ctx.time.nowSod() 的本地时区口径天然一致（同一宿主进程 TZ）。
 *
 * advance(ms) 算法（SIMULATION-DESIGN §4）：
 *   target = elapsed + ms；循环取 dueAt <= target 的最早定时器（dueAt + 序号排序）；
 *   elapsed = max(elapsed, dueAt)；移除并执行回调；回调内新排的定时器入队；
 *   每轮 await 微任务 + setImmediate 排空；步数与同刻触发双上限防 0ms 死循环。
 *
 * 安全边界：vm.runInContext 的 CPU 超时走真实时间（runner-core 保留），不在这里虚拟化。
 * 回调返回值会被 await——runner-core 的受控回调须返回 Promise 链，否则 async 判据不排空。 */
const DEFAULT_MAX_STEPS = 10000;
const DEFAULT_MAX_SAME_TICK = 1000;

function drain() {
  return new Promise((resolve) => {
    Promise.resolve().then(() => setImmediate(resolve));
  });
}

class VirtualClock {
  constructor({ startAt, maxSteps = DEFAULT_MAX_STEPS, maxSameTick = DEFAULT_MAX_SAME_TICK } = {}) {
    let epoch;
    if (startAt == null) epoch = Date.now();
    else if (startAt instanceof Date) epoch = startAt.getTime();
    else if (typeof startAt === 'number') epoch = startAt;
    else epoch = Date.parse(String(startAt));
    if (!Number.isFinite(epoch)) throw new Error('虚拟时钟起始时间非法：' + startAt);
    this.isVirtual = true;
    this.startEpoch = epoch;
    this.elapsed = 0;
    this.maxSteps = Math.max(1, Number(maxSteps) || DEFAULT_MAX_STEPS);
    this.maxSameTick = Math.max(1, Number(maxSameTick) || DEFAULT_MAX_SAME_TICK);
    this._seq = 0;
    this._timers = new Map();
    this._destroyed = false;
  }

  now() { return this.startEpoch + this.elapsed; }
  /* 相对 startAt 的虚拟毫秒：日志/写意图的 at 用这条时间轴（快照 §7.2） */
  elapsedMs() { return this.elapsed; }
  date() { return new Date(this.now()); }
  iso() { return this.date().toISOString(); }

  _add(kind, fn, ms, args, period) {
    if (this._destroyed) return 0;
    const id = ++this._seq;
    const delay = Math.max(0, Number(ms) || 0);
    this._timers.set(id, {
      id, dueAt: this.elapsed + delay, period,
      fn, args: args || [], kind, label: '', seq: id,
    });
    return id;
  }

  setTimeout(fn, ms, ...args) { return this._add('timeout', fn, ms, args, null); }
  setInterval(fn, ms, ...args) {
    const period = Math.max(0, Number(ms) || 0);
    return this._add('interval', fn, period, args, period);
  }
  clearTimeout(id) { return this._timers.delete(id); }
  clearInterval(id) { return this._timers.delete(id); }

  /* 给定时器打标签，供快照 timers[] 展示"脚本此刻在等什么"（§7.6） */
  label(id, text) {
    const t = this._timers.get(id);
    if (t) t.label = String(text == null ? '' : text).slice(0, 80);
    return !!t;
  }

  _pick(target) {
    let pick = null;
    for (const t of this._timers.values()) {
      if (t.dueAt > target) continue;
      if (!pick || t.dueAt < pick.dueAt || (t.dueAt === pick.dueAt && t.seq < pick.seq)) pick = t;
    }
    return pick;
  }

  async advance(ms) {
    const delta = Math.max(0, Number(ms) || 0);
    const target = this.elapsed + delta;
    let steps = 0;
    let lastDueAt = null;
    let sameTick = 0;
    const fired = [];
    while (!this._destroyed) {
      const t = this._pick(target);
      if (!t) break;
      if (++steps > this.maxSteps) {
        throw new Error(`虚拟时钟步数超限（>${this.maxSteps}），疑似定时器递归`);
      }
      if (t.dueAt === lastDueAt) {
        if (++sameTick > this.maxSameTick) {
          throw new Error(`虚拟时钟同刻触发超限（>${this.maxSameTick}@${t.dueAt}ms），疑似 0ms 死循环`);
        }
      } else { lastDueAt = t.dueAt; sameTick = 1; }

      this.elapsed = Math.max(this.elapsed, t.dueAt);
      if (t.kind === 'interval') {
        /* 周期定时器重排到下一拍；period=0 时保持同刻，靠 sameTick 上限兜底 */
        t.dueAt = this.elapsed + t.period;
      } else {
        this._timers.delete(t.id);
      }
      const info = { id: t.id, at: this.elapsed, kind: t.kind, label: t.label };
      fired.push(info);
      await t.fn(...t.args);
      await drain();
    }
    this.elapsed = target;
    return { advanced: delta, now: this.elapsed, iso: this.iso(), steps, fired };
  }

  /* 快照用：dueAt 为相对 startAt 的虚拟毫秒，与日志/写意图的 at 同时间轴 */
  timerList() {
    return [...this._timers.values()]
      .sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq)
      .map((t) => ({ id: String(t.id), dueAt: t.dueAt, kind: t.kind, label: t.label || '' }));
  }

  destroy() {
    this._destroyed = true;
    this._timers.clear();
  }
}

module.exports = { VirtualClock };
