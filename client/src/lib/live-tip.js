import { ref, getCurrentScope, onScopeDispose } from 'vue';

/* 拓扑条目 hover 实时取值（列表 / 单脚本图 / 全局图三处共用）。
 * 口径：
 * - 每次进入条目都重新请求，不缓存，读到的是服务器当下的值（GET /api/topology/live）；
 * - seq 丢弃过期响应：快速划过时旧目标的响应返回也不会覆盖新目标；
 * - pollMs > 0 时 hover 期间每 pollMs 自动刷新一次（图形视图长 hover 用，列表版靠 5s 面板刷新）；
 * - 位置 fixed 跟随鼠标，靠近视口边缘自动翻转，不受 details 折叠 / 画布缩放裁剪。
 * open 的 opts: { kind: 'entity'|'context', id, scriptId?, scriptIds?, mode?, title?, groupLabels? }
 * - 实体与 global 上下文的值与脚本无关 → 单请求；
 * - local 上下文的值存在 scriptId:mode 命名空间下 → scriptIds（owners）每个脚本各查一次，分组展示。 */

export function useLiveTip({ pollMs = 0 } = {}) {
  const tip = ref({ show: false, x: 0, y: 0, style: {}, loading: false, title: '', groups: [], note: '' });
  let seq = 0;
  let timer = null;
  let current = null;

  function fmtVal(v) {
    let text;
    if (typeof v === 'string') text = v;
    else { try { text = JSON.stringify(v); } catch (e) { text = String(v); } }
    return text.length > 240 ? `${text.slice(0, 240)}…` : text;
  }

  function entityRows(j) {
    const a = j.attributes || {};
    const rows = [{ k: '状态', v: j.state == null ? '—' : String(j.state) }];
    if (a.friendly_name) rows.push({ k: '名称', v: String(a.friendly_name) });
    if (a.unit_of_measurement) rows.push({ k: '单位', v: String(a.unit_of_measurement) });
    if (a.device_class) rows.push({ k: '类型', v: String(a.device_class) });
    return rows;
  }

  function entityNote(j) {
    if (j.status === 'unknown') return 'HA 未就绪，读不到当前值';
    if (j.status === 'missing') return '实体已不存在于 HA';
    return `读取于 ${new Date(j.at).toLocaleTimeString()}`;
  }

  function ctxRows(j) {
    return [{ k: '值', v: j.exists ? fmtVal(j.value) : '（未设置）' }];
  }

  function ctxNote(j) {
    return `读取于 ${new Date(j.at).toLocaleTimeString()}`;
  }

  async function fetchOnce(kind, id, scriptId, mode) {
    const q = new URLSearchParams({ kind, id, scriptId: scriptId || '', mode: mode || 'production' });
    const res = await fetch(`/api/topology/live?${q.toString()}`);
    const j = await res.json();
    if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  }

  /* 视口边界修正：优先鼠标右下，放不下翻到左/上 */
  function place() {
    const w = 340, h = 150;
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    let left = tip.value.x + 14;
    let top = tip.value.y + 18;
    if (left + w > vw - 8) left = Math.max(8, tip.value.x - w - 14);
    if (top + h > vh - 8) top = Math.max(8, tip.value.y - h - 12);
    tip.value.style = { left: `${left}px`, top: `${top}px` };
  }

  async function loadCurrent() {
    const my = ++seq;
    const t = current;
    if (!t) return;
    tip.value.loading = true;
    try {
      const multi = t.kind === 'context' && String(t.id).startsWith('local.') && t.scriptIds.length > 1;
      if (!multi) {
        const j = await fetchOnce(t.kind, t.id, t.scriptIds[0] || '', t.mode);
        if (my !== seq) return;
        tip.value.groups = [{
          rows: t.kind === 'entity' ? entityRows(j) : ctxRows(j),
          note: t.kind === 'entity' ? entityNote(j) : ctxNote(j),
        }];
      } else {
        /* 多脚本同 key 的 local 上下文：并行查每个脚本的命名空间，失败不影响其它分组 */
        const results = await Promise.all(t.scriptIds.map((sid) =>
          fetchOnce('context', t.id, sid, t.mode).then(
            (j) => ({ sid, j }),
            (e) => ({ sid, error: e.message || String(e) }),
          )));
        if (my !== seq) return;
        tip.value.groups = results.map(({ sid, j, error }) => ({
          label: t.groupLabels[sid] || sid,
          rows: error ? [{ k: '读取失败', v: error }] : ctxRows(j),
          note: error ? '' : ctxNote(j),
        }));
      }
      tip.value.loading = false;
    } catch (e) {
      if (my !== seq) return;
      tip.value.loading = false;
      tip.value.groups = [];
      tip.value.note = `读取失败：${e.message || e}`;
    }
  }

  function open(ev, opts) {
    seq++; // 作废在途响应
    if (timer) { clearInterval(timer); timer = null; }
    current = {
      kind: opts.kind,
      id: opts.id,
      scriptIds: opts.scriptIds || (opts.scriptId ? [opts.scriptId] : ['']),
      mode: opts.mode || '',
      groupLabels: opts.groupLabels || {},
    };
    tip.value = { show: true, x: ev.clientX, y: ev.clientY, style: {}, loading: true, title: opts.title || opts.id, groups: [], note: '' };
    place();
    loadCurrent();
    if (pollMs > 0) {
      timer = setInterval(() => {
        if (!document.hidden && tip.value.show && current) loadCurrent();
      }, pollMs);
    }
  }

  function move(ev) {
    if (!tip.value.show) return;
    tip.value.x = ev.clientX;
    tip.value.y = ev.clientY;
    place();
  }

  function hide() {
    seq++;
    if (timer) { clearInterval(timer); timer = null; }
    current = null;
    tip.value.show = false;
  }

  /* 审计 4.13：组件卸载（v-if 切视图）不经过 hide，轮询定时器会继续请求并写已卸载组件。
   * useLiveTip 都在 setup 里调用：借用当前作用域注册 dispose 清理，组件卸载即停轮询。 */
  if (getCurrentScope()) onScopeDispose(hide);

  return { tip, open, move, hide };
}
