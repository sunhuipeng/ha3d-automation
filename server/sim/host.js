'use strict';
/* 仿真宿主桥：在 worker 线程内应答 runner-core 的 request（getState/listEntities/
 * contextGet/contextSet/callService/callScript/taskStatus）。
 *
 * 关键约束（SIMULATION-DESIGN §4）：必须在同步或微任务内应答——所有方法同步返回，
 * 由调用方用 Promise.resolve 包一层回 core.handleMessage({type:'reply'})，绝不用宏任务
 * 假装 HA 延迟，否则 advance 快进会误触发 request 的 10s 超时。
 *
 * 安全边界（§9）：simulate 不持有 connector，callService 只落到虚拟实体表并记写意图，
 * 结构上没有真实 HA 引用可下发；callScript 与影子一致返回 mock 回执。 */
function createSimHost(world) {
  function filterEntities(filter) {
    const q = String(filter == null ? '' : filter).trim().toLowerCase();
    const out = [];
    for (const [entityId, ent] of world.entities) {
      if (!q || entityId.toLowerCase().includes(q) || String(ent.friendly_name || '').toLowerCase().includes(q)) {
        ent.used = true; // 脚本扫到了，就算用过（快照默认只回用过的实体）
        out.push({
          entityId,
          state: ent.state,
          attributes: ent.attributes || {},
          friendly_name: ent.friendly_name,
        });
      }
    }
    return out;
  }

  function handle(action, data) {
    const d = data || {};
    switch (action) {
      case 'getState': {
        const ent = world.entities.get(String(d.entityId || ''));
        if (!ent) return null;
        ent.used = true;
        return { state: ent.state, attributes: ent.attributes || {} };
      }
      case 'listEntities':
        return filterEntities(d.filter);
      case 'contextGet': {
        const scope = d.scope === 'global' ? 'global' : 'local';
        const bucket = world.context[scope] || (world.context[scope] = {});
        return Object.prototype.hasOwnProperty.call(bucket, d.key) ? bucket[d.key] : d.default;
      }
      case 'contextSet': {
        const scope = d.scope === 'global' ? 'global' : 'local';
        const bucket = world.context[scope] || (world.context[scope] = {});
        const prev = Object.prototype.hasOwnProperty.call(bucket, d.key) ? bucket[d.key] : null;
        bucket[d.key] = d.value;
        world.recordWrite({ kind: 'context', op: 'contextSet', desc: `${scope}.${d.key}`, args: [d.key, d.value] });
        if (scope === 'global') {
          world.dispatch({ type: 'contextChange', scope: 'global', key: d.key, value: d.value, prev, writerSid: world.scriptId, namespace: 'simulation' });
        }
        return { ok: true, scope, key: d.key };
      }
      case 'callService': {
        const eid = d.data && d.data.entity_id;
        world.recordWrite({
          kind: 'service', op: `${d.domain}.${d.service}`,
          desc: `${d.domain}.${d.service}${eid ? ' ' + eid : ''}`, args: [d.data],
        });
        /* 按 service 回写虚拟表（§3.2：可配延迟，P0 同步回写）。turn_on/off 常见形态。
         * 未知实体自动建表：脚本显式调用服务即视为"要观测它"，只记写意图不建实体的话，
         * state_changed 永远不派发，watch 该实体的分支会静默挂死（宁可世界多一个空实体）。 */
        const eidKey = String(eid || '');
        if (eidKey) {
          let ent = world.entities.get(eidKey);
          if (!ent) {
            ent = { state: null, attributes: {}, friendly_name: undefined, touched: false, used: false };
            world.entities.set(eidKey, ent);
          }
          ent.used = true; // 脚本对它有动作，快照里必须能看到
          const svc = String(d.service || '');
          let next = null;
          if (svc === 'turn_on') next = 'on';
          else if (svc === 'turn_off') next = 'off';
          /* toggle 会翻转：真实 HA 里 input_boolean.toggle 同样产生一次 state_changed，
           * 脚本 watch 该实体时会被重新触发。仿真必须同步翻转，否则「长按切自动模式 →
           * 立即复核」这条链在仿真里断掉（s4night 就靠它）。 */
          else if (svc === 'toggle') next = String(ent.state) === 'on' ? 'off' : 'on';
          else if (svc === 'set_value' && d.data && d.data.value !== undefined) next = String(d.data.value);
          if (next !== null) {
            const prev = { state: ent.state, attributes: ent.attributes || {} };
            ent.state = next;
            ent.touched = true;
            ent.used = true;
            world.dispatch({ type: 'state', entityId: eid, state: { state: ent.state, attributes: ent.attributes || {} }, prev });
          }
        }
        return { simulated: true, domain: d.domain, service: d.service, entityId: eid || null };
      }
      case 'callScript':
        return { id: String(d.scriptId || ''), version: 0, mode: 'shadow', started: true, mocked: true };
      case 'taskStatus': {
        const sid = String(d.scriptId || '');
        const injected = world.tasks.get(sid);
        const state = injected && injected.state ? injected.state : 'stopped';
        return { scriptId: sid, version: 0, mode: 'production', state, info: { scriptId: sid, version: 0, mode: 'production', reason: 'simulation' } };
      }
      default:
        return { error: '未知的仿真 action：' + action };
    }
  }

  return { handle };
}

module.exports = { createSimHost };
