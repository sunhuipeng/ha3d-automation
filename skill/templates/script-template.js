/* 【模板】ha3d-automation 长驻脚本骨架
 * 用法：复制本文件为任意路径下的源文件（如临时目录），替换 ⬜ 占位内容，删除用不到的段落注释。
 * 硬规则见 skill/SKILL.md 第 3 步；ctx 接口见 skill/references/ctx-api.md。 */

/* ⬜ 文件头注释：业务说明 + 触发/判据/动作三要素 + 关键设计决策 */

/* ⬜ 1. 顶层常量：实体 id、阈值、参数表——集中可改 */
const ENTITIES = {
  main: 'input_number.⬜',        // 主实体
  aux: 'switch.⬜',               // 联动设备
};
const THRESHOLD = 0;              // ⬜ 判据阈值
const TICK_MS = 60000;            // ⬜ 周期（如有）

/* ⬜ 2. 注册动作表：所有 HA 写调用只出现在这里，业务侧一律 ctx.write（第三参 nodeId 不可省略：位置参数，驱动日志归组与画布运行态高亮） */
ctx.actions({
  // 例：递减 / 置零 / 关设备 / 播报——命名带业务语义
  do_thing: () => ctx.ha.callService('input_number', 'decrement', { entity_id: ENTITIES.main }),
  off_device: () => ctx.ha.callService('switch', 'turn_off', { entity_id: ENTITIES.aux }),
});

/* ⬜ 3. 业务状态：自持状态机 + expected 防自发自收 + 定时器句柄 */
let selfValue = 0;                // 真相源：不依赖 HA 值驱动下一拍
const expected = {};              // expected[entityId] = 自己下发后期望的值
let timerId = null;

/* ⬜ 3.5 状态摘要行（推荐）：一处定义、多处复用——复核 / 规避 / 恢复等日志统一
 * 拼同一行快照，避免每处手拼状态字符串造成口径漂移；extra 可带本次特有信息。 */
function stateLine(extra) {
  return `阈值=${THRESHOLD} 当前=${selfValue} 定时=${timerId ? 'on' : 'off'}${extra ? '｜' + extra : ''}`;
}
// 用法：ctx.log('info', `复核｜${stateLine('动作=继续')}`, 'n_eval');

/* ⬜ 4. 定时重排（mode:restart 语义）：先 cancel 旧 id 再排新的 */
function arm() {
  if (timerId) ctx.cancel(timerId);
  if (!(selfValue > THRESHOLD)) { timerId = null; return; }
  timerId = ctx.after(TICK_MS, onTick);
}

async function onTick() {
  await ctx.lock('main', async () => {           // 防重入：定时器与订阅回调可能同时触发
    if (ctx.stopped) return;                     // 停止指令 → 让步退出
    const cur = await ctx.ha.num(ENTITIES.main, null);   // 每拍核对真实值；传 null = 读不到就跳过（断线/unavailable）
    if (cur === null || cur <= THRESHOLD) { timerId = null; return; }   // 保守分支：读不到或低于阈值都不推进
    selfValue = cur - 1;
    expected[ENTITIES.main] = selfValue;         // 记录期望值，watch 里过滤自发变化
    await ctx.write('do_thing', `⬜ 描述：${cur}→${selfValue}`, 'n_act');
    if (selfValue > THRESHOLD) { ctx.log('info', `继续｜剩余=${selfValue}`, 'n_act'); arm(); }
    else { await ctx.write('off_device', '⬜ 结束动作', 'n_act'); timerId = null; }
  });
}

/* ⬜ 5. 订阅外部事件：回调参数是完整状态对象 (nextObj, prevObj)，不是字符串 */
ctx.watch([ENTITIES.main, ENTITIES.aux], async (s) => {
  const eid = s && s.entity_id;
  if (eid === ENTITIES.aux) {
    /* 外部设备关闭 → 归零等联动判据 */
    return;
  }
  const val = await ctx.ha.num(ENTITIES.main, 0);
  if (expected[ENTITIES.main] === val) { expected[ENTITIES.main] = null; return; }   // 自发变化，忽略
  await ctx.lock('main', async () => {
    selfValue = val;
    ctx.log('info', `外部设值｜=${val}`, 'n_act');
    arm();                                        // mode:restart：外部改值即重排
  });
});

/* ⬜ 6. 启动：先拉取当前值作为基线（重启/重跑不是从零开始） */
const startVal = await ctx.ha.num(ENTITIES.main, 0);
selfValue = startVal;
ctx.log('info', `启动拉取｜当前=${startVal}${selfValue > THRESHOLD ? '，继续' : '，无需处理'}（${ctx.dryRun ? '影子模式' : '正式模式'}）`, 'n_start');
arm();

/* ⬜ 7. 长驻脚本保活（必须）；短任务脚本删除本行自然结束 */
await ctx.keepAlive();  // 常驻锚点：顶层永不结束，runner 不 emit done，等待实体推送与定时器
