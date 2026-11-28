'use strict';
/* 影子双模式验证：simulate 控制面（审计 3.1 从 executor.js 抽出）。
 * 职责：仿真会话控制（注入/推进/快照/批量用例/断言/标记回滚/导出重放/关闭）
 * 与 follow↔simulate 模式切换。会话以 scriptId 为键（影子槽位唯一）。
 * 所有控制请求经 worker 的 simReply 回执；请求超时用真实定时器（10s）——
 * 仿真的 request 在 worker 内微任务应答，不占用这条链路。
 *
 * 与 executor 的边界：本模块不持有实例表，依赖经 createSimControl(deps) 注入——
 * instancesOf/start/stop 等生命周期操作仍归 executor，本模块只做控制面编排。 */

const SIM_REPLY_TIMEOUT_MS = 10000;
const SWITCH_EXIT_TIMEOUT_MS = 2000;

function createSimControl(deps) {
  const { instancesOf, store, hub, start, stop, broadcastScript, broadcastRefresh, emitLog, clearError, getConnector } = deps;

  /* 仿真控制请求回执：requestId -> { resolve, reject, timer }（本模块私有状态） */
  const simPending = new Map();
  let simSeq = 0;

  function currentShadowEntry(sid) {
    return instancesOf(sid).find((e) => e.dryRun) || null;
  }

  function findSimEntry(sid) {
    const e = currentShadowEntry(sid);
    return e && e.verifyMode === 'simulate' ? e : null;
  }

  /* worker simReply 回执的唯一入口：executor 的 handleChildMessage 收到消息后转交这里 */
  function resolveSimReply(msg) {
    const p = simPending.get(msg.id);
    if (!p) return;
    simPending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || '仿真请求失败'));
  }

  /* 向影子实例发控制消息并等回执。未运行 / 非 simulate / 超时都会 reject。 */
  function simCall(sid, type, payload = {}) {
    const entry = findSimEntry(sid);
    if (!entry) return Promise.reject(new Error(`脚本 ${sid} 当前没有仿真（simulate）实例`));
    const id = ++simSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        simPending.delete(id);
        reject(new Error(`仿真请求超时：${type}`));
      }, SIM_REPLY_TIMEOUT_MS);
      simPending.set(id, { resolve, reject, timer });
      try { entry.child.send({ type, id, ...payload }); }
      catch (e) { simPending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  function simInject(sid, payload) { return simCall(sid, 'simInject', { payload }); }
  function simAdvance(sid, ms) { return simCall(sid, 'simAdvance', { ms }); }

  /* 快照：实例在跑就实时拉；实例已崩/已停则回退读崩溃只读快照（§5.2），
   * 让 AI 在失败之后仍能看到当时的写意图、终值与待触发定时器（只读，不能继续 advance）。 */
  async function simSnapshot(sid, opts) {
    if (!findSimEntry(sid)) {
      const v = store.versionOfChannel(String(sid || ''), 'shadow');
      const crash = v == null ? null : store.readSimCrash(String(sid || ''), v);
      if (crash) return { ...crash, version: v, readOnly: true, crashed: true, fromCrashFile: true };
    }
    return simCall(sid, 'simSnapshot', { opts });
  }

  /* 等脚本启动进入 keepAlive：steps 若在脚本注册订阅前跑，注入会被丢失。
   * 用真实定时器轮询（不占虚拟时钟），最多 ~1s。 */
  async function waitSimReady(sid, tries = 20) {
    for (let i = 0; i < tries; i += 1) {
      try {
        const snap = await simSnapshot(sid, { include: ['execution', 'watchers'] });
        if (snap && snap.execution && snap.execution.runCount > 0) return snap;
      } catch (e) { /* 还没就绪，重试 */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`脚本 ${sid} 仿真会话就绪超时`);
  }

  /* 批量用例（§7.4）：一次提交整组 steps 跑完并返回逐步断言。
   * 默认**重建**虚拟世界（用例必须可独立重跑，不能带着上一个用例的残留状态）；
   * 只有显式 continue:true 才在当前 simulate 会话上续跑（多段探索），此时不接受 startAt/seed。 */
  async function simRunSteps(sid, payload = {}) {
    const p = payload || {};
    const reuse = p.continue === true;
    if (reuse && (p.startAt !== undefined || p.seed !== undefined)) {
      throw new Error('continue:true 表示在当前仿真会话续跑，不能再指定 startAt/seed；要换起点请去掉 continue');
    }
    const hasSim = !!findSimEntry(sid);
    if (!reuse || !hasSim) {
      /* 每次重建都要新世界：即便目标模式相同也 force，否则 switchVerifyMode 会幂等返回旧世界。 */
      await switchVerifyMode(sid, 'simulate', { startAt: p.startAt, seed: p.seed, force: true });
    }
    await waitSimReady(sid);
    return simCall(sid, 'simRunSteps', { steps: p.steps, failFast: p.failFast });
  }
  /* ---- P2：交互式断言 / 标记回滚 / 用例导出与重放 ---- */

  /* 对当前仿真会话做一次断言（不重建世界）。step 用与 run_steps 的 assert 相同字段。 */
  function simAssert(sid, step, opts = {}) {
    return simCall(sid, 'simAssert', { step, since: opts.since });
  }

  /* 打点：记下当前虚拟世界数据（实体/上下文/task）。 */
  function simMark(sid, name) { return simCall(sid, 'simMark', { name }); }

  /* 回滚到标记点：只回滚输入世界，时钟与脚本状态不回退（见报告 P2 语义）。 */
  function simRewind(sid, name) { return simCall(sid, 'simRewind', { mark: name }); }

  /* 导出用例：把当前会话的起点 + 驱动流水 + 观测到的写意图存成 fixture。
   * 用例目录与服务端同一份（skill/.fixtures）后，导出即"写进资产库"：同名文件若已带 assert
   * 步骤（手写用例），默认拒绝覆盖——导出的 fixture 没有断言，覆盖等于把资产降级。 */
  async function simExport(sid, name, opts = {}) {
    const id = String(sid || '');
    if (!store.safeId(id)) throw new Error('脚本 id 非法');
    const existing = store.readFixture(id, name);
    if (existing && !opts.force && (existing.steps || []).some((s) => s && s.op === 'assert')) {
      throw new Error(`${name} 已存在且带断言（手写用例），拒绝用导出的 fixture 覆盖；换个 name 或传 force:true`);
    }
    const data = await simCall(sid, 'simExport');
    const v = store.versionOfChannel(id, 'shadow');
    const meta = v == null ? null : store.getMeta(id, v);
    const payload = {
      ...data, name: String(name), scriptVersion: v,
      scriptSha: (meta && meta.sha256) || null,
      exportedAt: new Date().toISOString(),
    };
    const file = store.writeFixture(id, name, payload);
    return { ok: true, scriptId: id, name: String(name), file, steps: (payload.steps || []).length, writes: ((payload.expected || {}).writes || []).length };
  }

  /* 重放 fixture：默认重建世界 → 跑 steps → 追加一条 since:0 的写意图全序列断言。
   * since:0 使追尾断言不受用例自带 assert 消耗 seq 游标的影响：自带 assert 验各段增量，
   * 追尾断言验全序列，两者各验各的、可以并存（旧实现直接跳过，会漏掉全序列这层校验）。
   * versionDrift 表示导出时的影子版号/源码 sha 与当前不同（脚本可能已改，断言失败先怀疑这个）。 */
  async function simRunFixture(sid, name, opts = {}) {
    const id = String(sid || '');
    const fx = store.readFixture(id, name);
    if (!fx) throw new Error(`没有这个用例：${name}（先 sim_export 或写到 skill/.fixtures/${id}/）`);
    const steps = Array.isArray(fx.steps) ? [...fx.steps] : [];
    const expected = ((fx.expected || {}).writes) || [];
    const hasOwnAsserts = steps.some((s) => s && s.op === 'assert');
    /* expected 为空且用例自带断言时追加空序列断言只会误报，此时不追尾；其余情况都追加。 */
    if (opts.assertWrites !== false && (expected.length > 0 || !hasOwnAsserts)) {
      steps.push({ op: 'assert', label: `fixture:${name}`, since: 0, writes: expected });
    }
    const r = await simRunSteps(id, { startAt: fx.startAt, seed: fx.seed, steps, failFast: opts.failFast });
    const curV = store.versionOfChannel(id, 'shadow');
    const curMeta = curV == null ? null : store.getMeta(id, curV);
    const curSha = (curMeta && metaSha(curMeta)) || null;
    /* 版号 + 源码 sha 双重比对：影子可原地覆盖（版号不变、内容变了），只看版号会漏。 */
    const drift = fx.scriptVersion !== curV || (!!fx.scriptSha && !!curSha && fx.scriptSha !== curSha);
    return {
      ...r,
      fixture: { name, scriptId: id, scriptVersion: fx.scriptVersion, currentVersion: curV, versionDrift: drift },
    };
  }

  const metaSha = (meta) => (meta && meta.sha256) || null;

  /* 列出某个脚本已存的用例（不带执行）。 */
  function simListFixtures(sid) {
    return { scriptId: String(sid || ''), fixtures: store.listFixtures(String(sid || '')) };
  }

  /* 关闭仿真会话：只对 simulate 影子实例生效。follow 影子是真实验证态，误调不能把它停掉
   * （那会让用户以为"关掉仿真"，实际停掉了实跑验证）；要停请走正常 stop。 */
  async function simClose(sid) {
    const entry = currentShadowEntry(sid);
    if (!entry) return { ok: true, scriptId: String(sid || ''), closed: false, note: '没有运行中的影子实例' };
    if ((entry.verifyMode || 'follow') !== 'simulate') {
      throw new Error('当前影子实例是 follow 模式（跟随真实），不是仿真；如需停止请调用 automation_stop_script');
    }
    try { await simCall(sid, 'simClose'); } catch (e) { /* worker 已退出也视为关闭成功 */ }
    stop(sid, 'sim-close', entry.version);
    return { ok: true, scriptId: String(sid || ''), closed: true };
  }

  /* 等实例真正退出：stop 是「置标志 + 宽限后 kill」，切换必须等 exit 确认，否则撞槽位。 */
  function waitExit(entry, timeoutMs = SWITCH_EXIT_TIMEOUT_MS) {
    if (entry.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; entry.child.off('exit', onExitEvt); clearTimeout(timer); resolve(v); };
      const onExitEvt = () => finish(true);
      entry.child.on('exit', onExitEvt);
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  /* 模式切换提示：属于运维事件，不是脚本运行日志。
   * 切到 simulate 时落 sim.log 并带虚拟时刻 at=0（切换发生在仿真会话起点）实时广播；
   * 不写版本日志——否则真实运行记录里会混进仿真期条目，事后排查分不清「哪次是真跑的」；
   * 切回 follow 时才正常落盘（此时已在真实模式）。 */
  function emitSwitchLog(sid, version, level, message, targetMode) {
    const line = { ts: Date.now(), scriptId: sid, version, level, message };
    if (targetMode === 'simulate') {
      /* 必须带 at——前端按「at!=null ? +X.Xs : 墙钟」渲染，缺 at 会显示成具体时分秒，
       * 和脚本日志的 +X.Xs 混排。同时落进 sim.log（与 worker 脚本日志同文件），刷新后仍在。 */
      const simLine = { ...line, at: 0 };
      store.appendSimLog(sid, version, simLine);
      hub.broadcast({ type: 'script', event: 'log', ...simLine, sim: true });
      return;
    }
    store.appendLog(sid, version, line);
    hub.broadcast({ type: 'script', event: 'log', ...line });
  }

  /* 切换验证方式：校验 → 暂停（等真正退出）→ 清理模式态 → 启动 → 回滚 → 广播。
   * 不做热切换；目标与当前相同幂等返回；正式实例是另一个槽位、完全不受影响。 */
  async function switchVerifyMode(sid, mode, opts = {}) {
    const id = String(sid || '');
    const target = mode === 'simulate' ? 'simulate' : 'follow';
    const shadowV = store.versionOfChannel(id, 'shadow');
    if (shadowV == null) throw new Error(`脚本 ${id} 没有影子版本，无法切换验证方式`);
    const cur = currentShadowEntry(id);
    if (cur) {
      const from = cur.verifyMode || 'follow';
      if (from === target && !opts.force) {
        return { from, to: target, idempotent: true, version: shadowV, verifyMode: target };
      }
    }
    const from = cur ? (cur.verifyMode || 'follow') : 'stopped';
    const startAt = Date.now();
    /* 瞬态 switching（§2.3）：前端显示「切换中」，避免暂停→启动的空窗被误读为崩溃。
     * 只是状态事件，不写版本日志、不影响正式槽位。 */
    if (cur) broadcastScript(id, shadowV, 'status', { status: 'switching', verifyMode: target });
    if (cur) {
      stop(id, 'mode-switch', shadowV);
      const exited = await waitExit(cur);
      if (!exited) {
        /* 宽限 + 超时仍未退出：强杀，避免撞槽位 */
        try { cur.child.kill(); } catch (e) {}
        await waitExit(cur, 500);
      }
    }
    /* simulate → follow 的虚拟世界随 worker 退出自然销毁（不持久化，§2.4）。
     * follow → simulate 无需额外清理。 */
    const launch = (m) => start(id, shadowV, getConnector(), 0, null, {
      verifyMode: m, startAt: opts.startAt, seed: opts.seed,
    });
    try {
      const entry = launch(target);
      broadcastScript(id, shadowV, 'status', { status: 'running', verifyMode: target });
      broadcastRefresh(['scripts', 'script']);
      emitSwitchLog(id, shadowV, 'warn', `[模式切换] ${from} → ${target}（暂停 ${Date.now() - startAt}ms，重新启动 v${shadowV}）`, target);
      return {
        from, to: target, idempotent: false, version: shadowV, verifyMode: target,
        pausedMs: Date.now() - startAt, clock: target === 'simulate' ? (opts.startAt || null) : null,
      };
    } catch (e) {
      /* 回滚：目标模式启动失败 → 尝试以原模式重启一次；仍失败则 stopped + error。 */
      try {
        if (from !== 'stopped') {
          launch(from);
          emitSwitchLog(id, shadowV, 'warn', `[模式切换] 启动 ${target} 失败，已回滚到 ${from}：${e.message}`, from);
        } else {
          throw e;
        }
      } catch (e2) {
        clearError(id, shadowV);
        broadcastScript(id, shadowV, 'status', { status: 'error' });
        emitLog({ sid: id, version: shadowV }, 'error', `[模式切换] 启动 ${target} 失败且回滚 ${from} 也失败：${e2.message}`);
      }
      throw e;
    }
  }

  return {
    resolveSimReply,
    switchVerifyMode,
    simInject, simAdvance, simSnapshot, simRunSteps, simAssert, simMark,
    simRewind, simExport, simRunFixture, simListFixtures, simClose,
  };
}

module.exports = { createSimControl };
