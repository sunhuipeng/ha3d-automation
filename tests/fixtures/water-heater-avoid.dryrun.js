/* ============================================================
 * 电热水器大功率规避脚本（影子版本 + 共享上下文）
 * ------------------------------------------------------------
 * 版本角色由服务端管理：影子版本所有 HA 写调用只写日志、绝不下发；
 * 正式版本才真实控制。脚本层调 ctx.write 是第一道闸，主进程还有二次硬拦截。
 *
 * 状态存放口径（按“谁读”分层，不按重要性）：
 *   内存       : avoiding 的当前值、highSince / allClearSince 计时
 *   ctx.global : waterHeater.avoiding / pendingStart  ← 唯一跨脚本契约
 *   HA 实体    : 只留“人要改 / 人要看的配置”（保温开关、总开关、上下限、时间、温度）
 * 本脚本不写任何本项目私有的 HA helper：规避状态是运行时临时状态，
 * 跨脚本用全局上下文即可，不再镜像 input_boolean。
 *
 * 判据：
 *   A 组 三路实时功率求和 > 800W 且持续 10s：
 *     电炒锅 sensor.cuco_cn_695113573_v3_electric_power_p_11_2
 *     烤箱   sensor.yutai_cn_2052307013_jdls1_electric_power_p_3_2
 *     电饭锅 sensor.cuco_cn_671705534_v3_electric_power_p_11_2
 *   B 组 无功率，开机即规避：
 *     电磁炉 sensor.chunmi_cn_113056718_v1_status_p_2_1 == 'Busy'
 *     空调   climate.lumi_cn_584491601_mcn02 state != off
 *   车机充电忽略；总功率传感器禁用（含热水器自身会自激）。
 *
 * 补开：夜间脚本到点若正在规避，会写 waterHeater.pendingStart=true。
 *       本脚本解除规避时若 pendingStart 为真、自动开开关未关、水温仍低于目标，则补开。
 * ============================================================ */

const CFG = {
  POWER_THRESHOLD: 800,
  POWER_HOLD_MS: 10000,
  COOLDOWN_MS: 30000,
  POLL_MS: 5000,
};

const ID = {
  wh:        'water_heater.212305750929166_water_heater',
  pWok:      'sensor.cuco_cn_695113573_v3_electric_power_p_11_2',
  pOven:     'sensor.yutai_cn_2052307013_jdls1_electric_power_p_3_2',
  pRice:     'sensor.cuco_cn_671705534_v3_electric_power_p_11_2',
  induction: 'sensor.chunmi_cn_113056718_v1_status_p_2_1',
  ac:        'climate.lumi_cn_584491601_mcn02',
  kwSwitch:  'input_boolean.re_shui_qi_bao_wen_mo_shi',
  autoSwitch:'input_boolean.zi_dong_kai_re_shui_qi_kai_guan',
  lower:     'input_number.re_shui_qi_bao_wen_zui_di_shui_wen',
  temp:      'sensor.dian_re_shui_qi_re_shui_qi_wen_du',
  target:    'sensor.dian_re_shui_qi_re_shui_qi_mu_biao_wen_du',
};

/* 业务动作仍在脚本里定义；影子拦截、日志、计数由框架 ctx.write 统一负责 */
ctx.actions({
  whOff: () => ctx.ha.callService('water_heater', 'turn_off', { entity_id: ID.wh }),
  whOn:  () => ctx.ha.callService('water_heater', 'turn_on',  { entity_id: ID.wh }),
});

/* 运行时状态：只在本进程内有意义，不进上下文也不进 HA */
let avoiding = false;
let highSince = 0;
let allClearSince = 0;

/* 只从全局上下文恢复跨脚本状态；计时器重启后重算（最坏多等一个持续/冷却窗口） */
async function loadContext() {
  avoiding = !!(await ctx.global.get('waterHeater.avoiding', false));
  highSince = 0;
  allClearSince = 0;
  if (avoiding) {
    const pending = !!(await ctx.global.get('waterHeater.pendingStart', false));
    ctx.log('warn', `恢复上下文｜上次运行处于规避中，继续规避直到电器全关（夜间补开=${pending}）`, 'n_start');
  } else {
    ctx.log('info', '恢复上下文｜当前不在规避中', 'n_start');
  }
}

/* 当前模式以 HA 实体为唯一真相，不保留“进入规避那一刻”的快照 */
async function detectMode() {
  if ((await ctx.ha.state(ID.kwSwitch)) === 'on') return 'keep_warm';
  return (await ctx.ha.num(ID.target)) >= 60 ? 'bath' : 'keep_warm';
}

async function sense() {
  const pWok = await ctx.ha.num(ID.pWok);
  const pOven = await ctx.ha.num(ID.pOven);
  const pRice = await ctx.ha.num(ID.pRice);
  const powerSum = pWok + pOven + pRice;
  const ind = await ctx.ha.state(ID.induction);
  const ac = await ctx.ha.state(ID.ac);
  return {
    pWok, pOven, pRice, powerSum,
    aHit: powerSum > CFG.POWER_THRESHOLD,
    ind, ac,
    bHit: ind === 'Busy' || (ac != null && ac !== 'off' && ac !== 'unavailable' && ac !== 'unknown'),
  };
}

async function enterAvoid(s, nodeId) {
  avoiding = true;
  allClearSince = 0;
  await ctx.global.set('waterHeater.avoiding', true);
  ctx.log('warn',
    `规避触发｜炒锅=${s.pWok}W 烤箱=${s.pOven}W 饭锅=${s.pRice}W 合计=${s.powerSum}W ` +
    `电磁炉=${s.ind} 空调=${s.ac}｜关热水器并标记规避中`, nodeId);
  await ctx.write('whOff', '大功率规避关热水器', nodeId);
}

async function exitAvoid(nodeId) {
  const mode = await detectMode();
  const pending = !!(await ctx.global.get('waterHeater.pendingStart', false));
  const auto = await ctx.ha.state(ID.autoSwitch);
  const temp = await ctx.ha.num(ID.temp);
  const target = await ctx.ha.num(ID.target);
  const lower = await ctx.ha.num(ID.lower);

  let shouldOn = false;
  let reason = '';
  if (auto === 'off') {
    reason = '自动开热水器开关已关闭，规避结束不自动开热水器';
  } else if (pending) {
    shouldOn = temp < target;
    reason = shouldOn ? `夜间补开（${temp}℃ < 目标 ${target}℃）` : '水温已达标，清掉补开标记，不重复加热';
  } else if (mode === 'keep_warm') {
    shouldOn = lower > 0 && temp < lower;
    reason = shouldOn ? `保温恢复（${temp}℃ < 下限 ${lower}℃）` : `保温区间内（${temp}℃ ≥ 下限 ${lower}℃）不重复开机`;
  } else {
    shouldOn = true;
    reason = `恢复加热到目标（${temp}℃ → ${target}℃）`;
  }

  ctx.log('info', `规避解除｜模式=${mode} 夜间补开=${pending} 自动开开关=${auto} 水温=${temp} 目标=${target} 下限=${lower}｜${reason}`, nodeId);

  await ctx.global.set('waterHeater.pendingStart', false);
  if (shouldOn) await ctx.write('whOn', pending ? '规避结束补开热水器' : `开热水器并恢复-${mode}`, nodeId);

  avoiding = false;
  allClearSince = 0;
  highSince = 0;
  await ctx.global.set('waterHeater.avoiding', false);
}

async function evaluate() {
  await ctx.lock(async () => {
    const s = await sense();
    const now = Date.now();
    ctx.log('info',
      `复核｜功率和=${s.powerSum}W(阈值${CFG.POWER_THRESHOLD}) A组=${s.aHit ? '命中' : '正常'} ` +
      `电磁炉=${s.ind} 空调=${s.ac} B组=${s.bHit ? '命中' : '正常'} 规避中=${avoiding}`, 'n_eval');

    const hit = s.aHit || s.bHit;
    if (hit) {
      allClearSince = 0;
      if (s.aHit) { if (!highSince) highSince = now; }
      else highSince = 0;
      const confirmed = s.bHit || (s.aHit && (now - highSince) >= CFG.POWER_HOLD_MS);
      if (confirmed && !avoiding) await enterAvoid(s, 'n_avoid');
    } else {
      highSince = 0;
      if (avoiding) {
        if (!allClearSince) {
          allClearSince = now;
          ctx.log('info', '电器已全关，开始冷却计时', 'n_cool');
        }
        if ((now - allClearSince) >= CFG.COOLDOWN_MS) await exitAvoid('n_recover');
      }
    }
  });
}

await loadContext();
ctx.log('info', `热水器规避脚本启动｜运行模式=${ctx.dryRun !== false ? '影子(只记日志)' : '正式(真实下发)'}｜阈值=${CFG.POWER_THRESHOLD}W`, 'n_start');
ctx.log('info', '状态分层：规避中/待补开走全局上下文；计时器只在内存；不写任何 HA helper', 'n_start');

ctx.watch([ID.pWok, ID.pOven, ID.pRice, ID.induction, ID.ac, ID.kwSwitch], () => { evaluate(); });

await evaluate();
setInterval(() => { evaluate(); }, CFG.POLL_MS);
await new Promise(() => {});
