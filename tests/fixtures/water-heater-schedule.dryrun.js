/* ============================================================
 * 电热水器「白天保温 + 夜间定时加热」脚本（影子版本）
 * ------------------------------------------------------------
 * 目标：完全接管 HA 现有 4 条原生自动化。
 *   白天：保温开关 on 时，水温低于下限 → 开；高于上限 → 关。
 *   夜间：读取 HA 可编辑的 input_datetime.re_shui_qi_kai_qi_shi_jian，
 *         到点且自动开开关 on → 设目标温度、退出保温、开热水器；
 *         达到目标温度后停机并恢复保温开关。
 *   规避中：到点不直接开，写 ctx.global waterHeater.pendingStart=true，
 *         由规避脚本解除规避时补开。
 *
 * 状态存放：到点标记 / 时间快照 / 写冷却时间戳都只被本脚本读 → ctx.local，不占全局；
 *           只有 waterHeater.avoiding（读）与 waterHeater.pendingStart（写）跨脚本，才走 ctx.global。
 *
 * 脚本层调 ctx.write 是第一道闸（影子只记日志），主进程还有二次硬拦截。
 * ============================================================ */

const CFG = {
  POLL_MS: 30000,
  ACTION_COOLDOWN_MS: 60000,
};

const ID = {
  wh:        'water_heater.212305750929166_water_heater',
  startTime: 'input_datetime.re_shui_qi_kai_qi_shi_jian',
  kwSwitch:  'input_boolean.re_shui_qi_bao_wen_mo_shi',
  autoSwitch:'input_boolean.zi_dong_kai_re_shui_qi_kai_guan',
  lower:     'input_number.re_shui_qi_bao_wen_zui_di_shui_wen',
  upper:     'input_number.re_shui_qi_bao_wen_mo_shi_shui_wen_shang_xian',
  temp:      'sensor.dian_re_shui_qi_re_shui_qi_wen_du',
  target:    'sensor.dian_re_shui_qi_re_shui_qi_mu_biao_wen_du',
};

/* 业务动作仍在脚本里定义；影子拦截、日志、计数由框架 ctx.write 统一负责 */
ctx.actions({
  whOn:      () => ctx.ha.callService('water_heater', 'turn_on',  { entity_id: ID.wh }),
  whOff:     () => ctx.ha.callService('water_heater', 'turn_off', { entity_id: ID.wh }),
  setTarget: (v) => ctx.ha.callService('water_heater', 'set_temperature', { entity_id: ID.wh, temperature: v }),
  kwOn:      () => ctx.ha.callService('input_boolean', 'turn_on',  { entity_id: ID.kwSwitch }),
  kwOff:     () => ctx.ha.callService('input_boolean', 'turn_off', { entity_id: ID.kwSwitch }),
});

let forceTrigger = false;
let lastHelperTs = null;

/* input_datetime 的 timestamp 属性是“当日秒数”，不是 Unix 时间戳 */
async function readStartSod() {
  const s = await ctx.ha.entity(ID.startTime);
  if (!s) return 20 * 3600 + 30 * 60;
  if (s.attributes && typeof s.attributes.timestamp === 'number') return ctx.num(s.attributes.timestamp);
  const p = String(s.state || '').split(':').map(Number);
  return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
}

/* 只恢复“重启后必须复原”的写冷却时间戳；其余临时状态留在内存 */
async function loadContext() {
  forceTrigger = false;
  lastHelperTs = null;
  ctx.log('info', '恢复上下文｜到点标记与时间快照为运行时临时状态，重启后按当前实体重新计算', 'n_start');
}

async function helperChanged(startSod) {
  if (lastHelperTs != null && lastHelperTs === startSod) return;
  const prev = lastHelperTs;
  lastHelperTs = startSod;
  if (prev == null) return;

  ctx.log('info', `HA 开启时间变更：${ctx.time.formatSod(prev)} → ${ctx.time.formatSod(startSod)}（当前 ${ctx.time.formatSod(ctx.time.nowSod())}）`, 'n_time');
  const last = await ctx.local.get('schedule.lastDate', null);
  if (startSod > ctx.time.nowSod()) {
    if (last === ctx.time.today()) {
      await ctx.local.set('schedule.lastDate', null);
      ctx.log('info', '改为未来时间：清掉当日触发标记，按新时间重新等待', 'n_time');
    }
  } else if (last !== ctx.time.today()) {
    forceTrigger = true;
    ctx.log('info', '改为已过去时间且当日未触发：按立即补开处理', 'n_time');
  }
}

async function actionAllowed(key) {
  const last = ctx.num(await ctx.local.get(key, 0));
  if (Date.now() - last < CFG.ACTION_COOLDOWN_MS) return false;
  await ctx.local.set(key, Date.now());
  return true;
}

async function ensureTarget(target) {
  const s = await ctx.ha.entity(ID.wh);
  const cur = s && s.attributes && s.attributes.temperature != null ? ctx.num(s.attributes.temperature) : null;
  if (cur != null && Math.abs(cur - target) < 0.1) return;
  await ctx.write('setTarget', `设置目标温度 ${target}°C`, 'n_night', target);
}

async function onSchedule(temp, target, avoiding, auto) {
  if (auto === 'off') {
    ctx.log('warn', '到点但自动开热水器开关已关闭，跳过本次开启', 'n_night');
    return;
  }
  if (avoiding) {
    await ctx.global.set('waterHeater.pendingStart', true);
    ctx.log('warn', '到点但正在规避：写 pendingStart=true，等规避解除后补开', 'n_night');
    return;
  }
  if (temp >= target) {
    await ctx.write('kwOn', '到点但水温已达标，恢复保温模式', 'n_night');
    ctx.log('info', '到点水温已达标，不重复加热', 'n_night');
    return;
  }
  await ensureTarget(target);
  await ctx.write('kwOff', '夜间加热：退出保温模式', 'n_night');
  await ctx.write('whOn', `夜间加热：开热水器（${temp}°C → ${target}°C）`, 'n_night');
}

async function thermostat(kw, temp, target, lower, upper, whOn, avoiding) {
  if (avoiding) return;
  if (temp == null || lower == null || upper == null) return;

  if (kw === 'on') {
    if (temp < lower && !whOn) {
      if (await actionAllowed('schedule.lastKeepWarmAt')) await ctx.write('whOn', `保温加热：水温 ${temp}°C < 下限 ${lower}°C`, 'n_keep');
    } else if (temp > upper && whOn) {
      if (await actionAllowed('schedule.lastKeepWarmAt')) await ctx.write('whOff', `保温停机：水温 ${temp}°C > 上限 ${upper}°C`, 'n_keep');
    }
    return;
  }

  // 非保温 = 夜间加热模式：只负责达标停机，不在这里重复开热水器
  if (whOn && temp >= target) {
    if (!(await actionAllowed('schedule.lastBathAt'))) return;
    await ctx.write('whOff', `达到目标温度 ${temp}°C ≥ ${target}°C，停机`, 'n_bath');
    await ctx.write('kwOn', '加热完成，恢复保温模式', 'n_bath');
  }
}

async function evaluate() {
  await ctx.lock(async () => {
    const startSod = await readStartSod();
    await helperChanged(startSod);

    const kw = await ctx.ha.state(ID.kwSwitch);
    const auto = await ctx.ha.state(ID.autoSwitch);
    const temp = await ctx.ha.num(ID.temp, null);
    const target = await ctx.ha.num(ID.target, null);
    const lower = await ctx.ha.num(ID.lower, null);
    const upper = await ctx.ha.num(ID.upper, null);
    const whState = await ctx.ha.entity(ID.wh);
    const whOn = whState ? String(whState.state) === 'on' : false;
    const avoiding = !!(await ctx.global.get('waterHeater.avoiding', false));
    const lastDate = await ctx.local.get('schedule.lastDate', null);
    const today = ctx.time.today();

    ctx.log('info',
      `复核｜开启时间=${ctx.time.formatSod(startSod)} 现在=${ctx.time.formatSod(ctx.time.nowSod())} 保温=${kw} 自动开=${auto} ` +
      `水温=${temp} 目标=${target} 下限=${lower} 上限=${upper} 热水器=${whState ? whState.state : '-'} ` +
      `规避中=${avoiding} 当日已触发=${lastDate === today}`, 'n_eval');

    const hit = (forceTrigger || ctx.time.nowSod() >= startSod) && lastDate !== today;
    if (hit && temp != null && target != null) {
      await onSchedule(temp, target, avoiding, auto);
      await ctx.local.set('schedule.lastDate', today);
      forceTrigger = false;
    }
    await thermostat(kw, temp, target, lower, upper, whOn, avoiding);
  });
}

await loadContext();
ctx.log('info', `热水器定时脚本启动｜模式=${ctx.dryRun !== false ? '影子(只记日志)' : '正式(真实下发)'}`, 'n_start');

ctx.watch([ID.startTime, ID.kwSwitch, ID.autoSwitch, ID.temp, ID.target, ID.lower, ID.upper, ID.wh], () => { evaluate(); });

await evaluate();
setInterval(() => { evaluate(); }, CFG.POLL_MS);
await new Promise(() => {});
