import { defineStore } from 'pinia';

/* 所有 POST/DELETE 的错误响应都是 { error: '...' }：统一在此转为异常，
 * 避免调用方各自 if (r.error) throw 造成漏检，也让成功路径直接拿到响应体。 */
function unwrap(r) {
  if (r && r.error) throw new Error(r.error);
  return r;
}

export const useScriptStore = defineStore('scripts', {
  state: () => ({
    list: [],
    current: null,       // { id, version, meta, running, runningVersions }
    versions: [],        // 当前脚本的版本列表（含角色/可改性/归档类型）
    shadowVersion: null,
    productionVersion: null,
    runningVersions: [], // 实例真正在跑的列表 [{version, mode}]：正式与影子可各有一个（运行态唯一真相源）
    logs: [],
    logsSource: 'real',  // 'real' = v<n>.log；'sim' = v<n>.sim.log（仿真实例运行时）
    nodeStates: {},      // nodeId -> state（运行时投影，不写回 flow.json）
  }),
  getters: {
    /* 当前打开版本实例的验证方式：'follow' | 'simulate'，无实例为 null。
     * runningVersions 仍是唯一真相源，verifyMode 只是实例上的一个属性。 */
    currentVerifyMode(state) {
      if (!state.current) return null;
      const row = state.runningVersions.find((x) => x.version === state.current.version);
      return row ? (row.verifyMode || 'follow') : null;
    },
  },
  actions: {
    async load() {
      this.list = await fetch('/api/scripts').then((r) => r.json());
    },
    async open(id, version) {
      const q = version ? `?version=${version}` : '';
      this.current = await fetch(`/api/script/${id}${q}`).then((r) => r.json());
      /* 换脚本必须清空节点运行状态投影：nodeStates 按 nodeId（n_start 等）键控，
       * 不清会把上一个脚本的运行痕迹画到新脚本流程图上 */
      this.nodeStates = {};
      /* 用详情的运行态真相回填左侧列表徽标，防止列表残留旧状态。
       * 必须用 scriptStatus（脚本级口径）：status 是版本级（当前打开版本的徽章），
       * 影子版本 stopped 会把脚本级 error 遮蔽掉。 */
      /* 先回填 runningVersions，后续选日志源（real/sim）依赖它 */
      this.runningVersions = this.current.runningVersions || [];
      const item = this.list.find((x) => x.id === id);
      if (item) {
        item.status = this.current.scriptStatus || this.current.status || 'stopped';
        item.runningVersions = this.current.runningVersions || [];
      }
      await Promise.all([this.loadLogs(id, this.current.version, 100, this.logsSourceForCurrent()), this.loadVersions(id)]);
      /* API 的 running = 该脚本任一实例在跑；这里收敛为"当前打开版本是否有实例"（与头部按钮对应） */
      this.syncRunning();
    },
    async loadVersions(id) {
      if (!id) return;
      const r = await fetch(`/api/script/${id}/versions`).then((x) => x.json());
      this.versions = r.versions || [];
      this.shadowVersion = r.shadowVersion;
      this.productionVersion = r.productionVersion;
      this.runningVersions = r.runningVersions || [];
    },
    /* 打开脚本面板只拉最近 100 行（后端仍支持 ?limit= 覆盖）；实时日志由 WS 增量追加。
     * source='sim' 读仿真独立日志（v<n>.sim.log）——仿真实例运行时不该给用户看真实日志，
     * 否则会把虚拟世界里的行为误当成真实运行记录。 */
    async loadLogs(id, version, limit = 100, source = 'real') {
      const q = new URLSearchParams({ limit: String(limit) });
      if (version) q.set('version', version);
      if (source === 'sim') q.set('source', 'sim');
      const r = await fetch(`/api/script/${id}/logs?${q}`).then((x) => x.json());
      this.logs = r.logs || [];
      this.logsSource = r.source || source;
    },
    /* 当前场景该读哪份日志：只有「当前打开版本的实例正在仿真」时才读 sim */
    logsSourceForCurrent() {
      const c = this.current;
      if (!c) return 'real';
      return this.currentVerifyMode === 'simulate' ? 'sim' : 'real';
    },
    /* 切换影子验证方式（follow ↔ simulate）：后端暂停→启动，再同步状态与日志源。
     * 前端不做乐观更新——以服务端返回和广播为准，避免模式与实例不一致。 */
    async switchVerifyMode(id, mode) {
      const r = await fetch(`/api/script/${id}/verify-mode`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      }).then((x) => x.json()).then(unwrap);
      await this.syncStatus(id);
      if (this.current && this.current.id === id) {
        await this.loadLogs(id, this.current.version, 100, mode === 'simulate' ? 'sim' : 'real');
      }
      return r;
    },
    /* 启停后同步状态：刷新列表/版本，并用详情的运行态（executor 内存合成）覆盖当前徽标（WS 事件的兜底） */
    async syncStatus(id, version) {
      await Promise.all([this.load(), this.loadVersions(id)]);
      if (!this.current || this.current.id !== id) return;
      const q = version ? `?version=${version}` : '';
      const detail = await fetch(`/api/script/${id}${q}`).then((x) => x.json());
      this.current.meta = detail.meta;
      this.runningVersions = detail.runningVersions || [];
      this.syncRunning();
    },
    async start(id, version) {
      const r = await fetch(`/api/script/${id}/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }),
      }).then((x) => x.json()).then(unwrap);
      await this.syncStatus(id, version);
    },
    /* 一次性脚本（script/scene）按次触发：跑完自然退出，不常驻。
     * channel='shadow' 触发影子版本（写操作只记日志，不改 HA 实体）；缺省走正式。 */
    async trigger(id, channel) {
      const r = await fetch(`/api/script/${id}/trigger`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(channel ? { channel } : {}),
      }).then((x) => x.json()).then(unwrap);
      await this.syncStatus(id);
      return r;
    },
    async stop(id, version) {
      await fetch(`/api/script/${id}/stop`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(version ? { version } : {}),
      });
      await this.syncStatus(id);
    },
    /* 发布影子版本为正式版本（真实下发），旧正式自动归档 */
    async publish(id, version) {
      const r = await fetch(`/api/script/${id}/publish`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }),
      }).then((x) => x.json()).then(unwrap);
      await Promise.all([this.load(), this.loadVersions(id)]);
      await this.open(id, version || r.version);
      return r;
    },
    /* 清理版本（运行中版本不可删） */
    async deleteVersion(id, version) {
      const r = await fetch(`/api/script/${id}/version/${version}`, { method: 'DELETE' }).then((x) => x.json()).then(unwrap);
      await this.load();
      await this.loadVersions(id);
      // 删掉的是当前打开的版本则回退到最新版本
      if (this.current && this.current.id === id && this.current.version === version) {
        const rest = this.versions;
        if (rest.length) await this.open(id, rest[0].version);
        else this.current = null;
      }
      return r;
    },
    /* 回滚：把历史版本内容提交为新版本（影子），不自动发布 */
    async rollback(id, fromVersion) {
      const r = await fetch(`/api/script/${id}/rollback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromVersion }),
      }).then((x) => x.json()).then(unwrap);
      await this.load();
      await this.loadVersions(id);
      await this.open(id, r.version);
      return r;
    },
    /* 当前打开版本是否有实例：runningVersions 是唯一真相源。
     * open / syncStatus / WS setStatus 三处同源派生，避免口径漂移。 */
    syncRunning() {
      if (!this.current) return;
      this.current.running = this.runningVersions.some((x) => x.version === this.current.version);
    },
    /* 运行时日志事件：只追加，不改动 flow（展示层只读）。
     * sim 日志与服务端广播分两条流：当前在仿真就看 sim 条目，否则只看真实日志，
     * 避免切换瞬间两边的行混在一起。 */
    pushLog(entry) {
      const isSim = entry.sim === true;
      if (this.logsSource === 'sim' ? !isSim : isSim) return;
      this.logs.push(entry);
      if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    },
    /* WS 状态事件：runningVersions 是唯一真相源。
     * 先增删条目、再派生 running（顺序错了停止事件会因 stale 条目卡在"运行中"）；
     * current.running 只反映**当前打开版本**是否有实例——头部按钮对应版本条选中项，
     * 想停另一版本在版本条上点开它即可（避免"停止"一次停掉正式+影子两个实例）。
     * mode：服务端 status 事件附带实例通道（broadcastScript 从 running 表读）；
     * verifyMode：实例的验证方式（follow/simulate），切换时随之更新徽章。
     * 缺席（实例已摘除的终态事件）才回退用 shadowVersion 反推。 */
    setStatus(status, version, mode, verifyMode) {
      if (!this.current) return;
      /* 切换空窗：暂停旧实例会先广播 stopped，随后才 running。保留下发起始的 switching，
       * 否则用户会看到「切换中 → 已停止 → 运行中」的假崩溃闪动。 */
      if (status === 'stopped' && this.current.status === 'switching') return;
      const live = status === 'running' || status === 'paused' || status === 'switching';
      const v = version || this.current.version;
      if (live) {
        const m = mode || ((this.shadowVersion === v) ? 'shadow' : 'production');
        const row = this.runningVersions.find((x) => x.version === v);
        if (row) { row.mode = m; if (verifyMode) row.verifyMode = verifyMode; }
        else this.runningVersions.push({ version: v, mode: m, verifyMode: verifyMode || 'follow' });
      } else {
        this.runningVersions = this.runningVersions.filter((x) => x.version !== v);
      }
      this.syncRunning();
      /* 运行状态在顶层（详情接口由 executor 内存合成，meta.json 已不存 status） */
      if (v === this.current.version) this.current.status = status;
      const row = this.versions.find((x) => x.version === v);
      if (row) row.status = status;
      const item = this.list.find((x) => x.id === this.current.id);
      if (item) {
        if (v === this.current.version) item.status = status;
        item.runningVersions = [...this.runningVersions];
      }
      /* 模式切换完成（running 且带 verifyMode）：日志源跟着切，并重拉一次对应文件 */
      if (status === 'running' && verifyMode && v === this.current.version) {
        const want = verifyMode === 'simulate' ? 'sim' : 'real';
        if (this.logsSource !== want) {
          this.logsSource = want;
          this.loadLogs(this.current.id, v, 100, want).catch(() => {});
        }
      }
    },
  },
});
