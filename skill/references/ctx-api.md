# ctx API 完整参考

ctx 是脚本唯一能访问的宿主能力。所有 HA 调用经白名单转发执行。

## 静态校验禁用清单（提交时 AST 校验，报错带行号）

| 类别 | 禁止内容 |
|---|---|
| 标识符 | `require`、`process`、`globalThis`、`eval`、`Function`、`module`、`exports`、`__dirname`、`__filename`、`Buffer`、`fetch`、`XMLHttpRequest`、`WebSocket`、`importScripts`、裸 `global`（`ctx.global` 例外） |
| 语句 | `import` / `export` / 动态 `import()` |
| 模块访问 | `fs` / `net` / `http` / `https` / `child_process` / `os` / `path` / `vm` / `dns` / `tls` |
| 成员访问 | 任何对象的 `.constructor` / `.__proto__` / `.prototype` / `.call` / `.apply` / `.bind`（含 `obj['constructor']` 写法）；**唯一例外：`ctx.call`（`ctx` 直接下属，`ctx['call']` 亦可）** |

## 可用内建

`Math` / `Date` / `JSON` / `Promise` / `console.log` / `console.error` / `setTimeout` / `clearTimeout` / `setInterval` / `clearInterval`

## ctx.ha — HA 状态读写

| 接口 | 签名 | 参数 / 返回值 |
|---|---|---|
| `entity` | `await ctx.ha.entity(entityId)` | 完整状态对象 `{ entity_id, state, attributes, ... }`；实体不存在或 HA 断线返回 `null` |
| `state` | `await ctx.ha.state(entityId)` | **原样**返回 `state` 字符串（`'on'` / `'unavailable'`…），有效性由脚本用 `ctx.invalid` 自己判；不存在返回 `null` |
| `num` | `await ctx.ha.num(entityId, fallback?)` | state 转数字；**实体缺失 / 状态无效（`ctx.invalid` 为真）/ 非数字串三种情况都返回 `fallback`（默认 0）**。传 `null` 或 `100` 会真正兑现，用于保守跳过或安全默认值 |
| `attr` | `await ctx.ha.attr(entityId, key, fallback?)` | 读**单个**属性（如 `hvac_action`、`timestamp`）；实体/属性缺失返回 `fallback`（默认 `null`） |
| `attrs` | `await ctx.ha.attrs(entityId, fallback?)` | 读**整个** `attributes` 对象；实体缺失/无属性返回 `fallback`（默认 `null`） |
| `listEntities` | `await ctx.ha.listEntities(filter?)` | 列出实体，`filter` 可选字符串过滤 |
| `callService` | `await ctx.ha.callService(domain, service, data)` | HA 服务调用。**只允许写在 `ctx.actions` 注册的函数体内** |
| `change` | `ctx.ha.change(entityId, cb)` | 订阅变化。回调签名固定 `(nextObj, prevObj)` 两个**完整状态对象**，要字符串取 `nextObj.state` |
| `subscribe` | `ctx.ha.subscribe(condition, cb)` | 简化版：`condition` 为 entityId 字符串或 `{ entityId }`；回调内异常被忽略 |

## ctx.actions + ctx.write — 动作与统一写入口

```js
ctx.actions({ 动作名: (…args) => {…}, ... })            // 重复注册抛错
const ok = await ctx.write(op, desc, nodeId, ...args)    // 唯一写入口
```

`ctx.write` 参数：

| 参数 | 含义 |
|---|---|
| `op` | 动作名，必须已注册（未注册抛错） |
| `desc` | 日志描述文案 |
| `nodeId` | 关联画布节点 id（`n_xxx`）：**位置参数，不可省略**（省略会让 `...args` 前移错位）。日志按节点结构化落盘（`get_logs` 返回带 nodeId），并驱动前端画布运行态高亮（`error` 红 / 其余绿） |
| `...args` | 透传给动作函数的参数 |

`ctx.write` 行为顺序与返回值：

1. 动作未注册 → 抛错；
2. 挂起中（`ctx.suspended === true`）→ 跳过，记 `[兜底] 动作已跳过` 日志，返回 `false`；
3. 影子模式（`ctx.dryRun !== false`）→ 跳过，记 `[影子·拦截写操作]` 日志，返回 `false`；
4. 全局开发模式（`HA3D_DEV_MODE=true`，含正式通道实例）→ 跳过，记 `[开发模式·拦截写操作]` 日志，返回 `false`；
5. 正常 → 执行动作，记 `[真实写操作]` 日志，返回 `true`。

`dryRun`（脚本通道身份）与开发模式（环境写拦截）正交：开发模式下正式实例仍是正式身份、上下文仍写正式桶，只是设备写不下发。主进程 `callService` 有同样的两道闸（影子 / 开发模式），脚本绕过 `ctx.write` 直调 `ctx.ha.callService` 也拦得住。MCP 直调 HA 不受开发模式限制（用户显式 confirmed 操作）。

## ctx.global / ctx.local — 上下文存储

### 先选存储层：按消费者，不按重要性

写脚本前先判"**谁要用这个数据**"，再决定存哪里。**不要因为一个值"重要"就塞进全局**，判据是消费者数量和重启语义：

| 数据特征 | 存哪里 | 例子 |
|---|---|---|
| **另一个脚本要读或写**（跨脚本共享的事实/状态/裁决结果） | **`ctx.global`** 全局上下文 | `home.highPower`（m7 产出、audr76je 消费）、`waterHeater.avoiding` / `pendingStart`（两脚本互读写） |
| **只有本脚本读，但服务重启后要恢复上次状态**（重启可复原，跨脚本不关心） | **`ctx.local`** 本地上下文（按 `脚本id:通道` 隔离） | 本脚本自己的阶段标记、上次的加热目标记录 |
| **只有本脚本读，重启后可重算/归零无所谓**（纯粹的过程变化） | **脚本内普通变量**（内存） | `since` / `timer` 计时状态、`expected` 防自发自收表、临时中间量 |
| **人要改、人要看的配置**（阈值、开关、时间点） | **HA 实体**（`input_number` / `input_boolean` / `input_datetime`），**不进上下文** | 目标水温、动态开启时间 |

补充规则：

1. **全局 key 带业务前缀**（如 `home.highPower`），值形态（布尔 / 对象字段）要先定契约；改形态必须同步所有消费者，不能只改写侧。
2. **私有状态不镜像 HA**：本项目自用的运行时状态不要为了"看着统一"去建 HA helper 实体；只有 HA 侧确实有外部消费者时才单向输出一份。
3. **影子读不隔离的后果**：影子实例 `ctx.global.set` 写进 shadow 桶，但 `get` 读 production 桶——"影子写、自己读回"这条链路不成立。需要立刻读回自持的状态用内存变量，影子写入以日志为验证依据。
4. **跨脚本读写用 `ctx.lock` 防并发环**；`ctx.local` 没有 `watch`，本脚本内部状态变化自己维护即可。

| 接口 | 说明 |
|---|---|
| `await ctx.global.get(key, fallback?)` | 全局**读**：所有实例（含影子）一律读 `production` 命名空间，读不隔离 |
| `await ctx.global.set(key, value)` | 全局**写**：仍按调用者模式隔离，影子写进 `shadow`、正式写进 `production`，绝不互相污染 |
| `ctx.global.watch(key, cb)` | 只订阅 `production` 命名变更；返回 `off()`；回调 `(value, prev, info)`，首次 `prev = null`，`info = { key, writerSid, namespace }`（`namespace` 恒为 `production`） |
| `await ctx.local.get(key, fallback?)` / `set(key, value)` | 脚本局部，按 `脚本id:通道` 隔离；无 watch（私有桶无需跨脚本通知） |

`key` 建议带业务前缀（如 `'schedule.lastHelperTs'`）。注意影子脚本 `set` 后 `get` 读的是正式桶，**读不到自己刚写的值**——这是读不隔离、写隔离的刻意结果；影子验证看日志里的写入行即可。开发模式下正式通道实例保持正式身份，写入落 `production` 桶、可被所有脚本（含影子）读到；影子实例写入仍落 `shadow` 桶、不影响正式数据。

`ctx.global.watch` 语义：只有写入 `production` 桶才触发，影子写入不触发任何监听者；写者自己不收到回调，同值重复 `set` 不触发。回调内可继续 `set`（跨实例互写要自行用 `ctx.lock` 防循环）。典型用法：

```js
const off = ctx.global.watch('avoiding', (value, prev, info) => {
  if (value === true && prev !== true) ctx.log('info', '进入规避：' + info.writerSid);
});
// 不再需要时 off()
```

## ctx.call — 脚本间显式联动

```js
const r = await ctx.call(scriptId, params?);   // 触发另一个短脚本/场景
// 影子调用者：r = { id, version, mode: 'shadow', started: true, mocked: true }（mock，被调方不执行）
// 正式调用者：r = { id, version, mode: 'production', started: true }（真实拉起）
```

| 项 | 规则 |
|---|---|
| 等待语义 | 只等启动回执，**不等**被调脚本执行完；失败时 reject（用 `try/catch` 接） |
| 影子 mock | **影子实例的 ctx.call 不真实拉起被调脚本**（影子硬隔离延伸）：只做与正式路径一致的校验（目标存在影子版 / 非常驻 / params 可序列化），打 `[联动][影子] …已 mock` 日志并回 `mocked:true` 回执，脚本逻辑可继续；影子 mock 不检查 busy/restartable。要验证被调方真实执行，需正式调用或单独触发 |
| `params` | 必须可 JSON 序列化；被调脚本用 `ctx.params` 读取（未被调用时为 `null`） |
| 版本 | 正式调用拉起目标正式版；影子调用回执里的 version 是目标影子版本号（仅校验用，未执行） |
| 目标类型 | 只允许一次性脚本/场景（`kind=script/scene`）；常驻自动化（`kind=automation`）不可调用 |
| 重入 | 目标已在跑默认拒绝；目标 `restartable:true` 则停旧启新 |
| 递归 | 调用链最多 5 层，超限报错中断 |

示例：`await ctx.call('ngvgq6ln', { minutes: 30 });` ——被调脚本开头 `const min = ctx.params?.minutes ?? 30;`。

## ctx.scriptId / ctx.task / ctx.watch.task — 依赖脚本运行状态

任意脚本都能读到自己的 id，也能查询/等待/订阅**另一个脚本实例**的运行状态。没有配置式的 `dependsOn` 声明，依赖关系完全写在脚本里。

```js
ctx.scriptId                                   // 字符串：executor 注入的权威脚本 id
const st = await ctx.task.status('depId');      // 查一次，不等待
const dep = await ctx.task.require('depId', { timeout: 30000 }); // 等到 running
const off = ctx.watch.task('depId', (state, info) => { ... });   // 订阅状态变化
off();                                         // 注销
```

`status` / `require` 返回 `{ scriptId, version, mode, state, info }`：

| 字段 | 含义 |
|---|---|
| `version` | 实际命中的实例版本（查不到实例时取该通道最新版本） |
| `mode` | 保留字段，恒为 `'production'`（只读接口固定看正式实例，仅用于日志辨识） |
| `state` | `'running'` / `'paused'` / `'stopped'` / `'error'` |
| `info` | `{ scriptId, version, mode, reason }`，`reason` 说明来源（如 `subscribed` / `started` / `stopped`） |

**通道规则（读不隔离）**：状态查询、等待、监听一律看依赖的**正式实例**，与调用者影子/正式无关。影子实例在跑也不算依赖就绪；没有正式实例时返回 `stopped`。这些接口全是只读，不产生设备副作用，所以不做通道隔离；`mode` 正常恒为 `production`，只用于日志辨识。依赖不健康时的写操作短路由业务脚本自己负责。

`ctx.task.require` 语义：

- 一次性门闩：等到**第一次** `running` 就 resolve，之后依赖重启/停止不再阻断当前脚本；
- 默认超时 30s（`{ timeout: ms }` 可覆盖），超时抛错，脚本自己决定退出还是降级；
- 脚本收到 `stop` 时立即中断等待并抛错，不会挂住 stop 流程；
- 查不到实例时返回的 `state` 是 `stopped`（版本 meta 为异常时是 `error`），不会自动启动依赖。

`ctx.watch.task(scriptId, cb)` 语义：

- 回调 `(state, info)`；**注册时主进程立即回放一次当前状态**，否则依赖早已启动时永远等不到"从无到有"；
- `off()` 幂等，返回是否成功注销；实例停止时订阅自动摘除；
- 依赖重启会产生 `stopped → running` 两次事件，**抖动由业务侧防抖吸收**（框架只如实上报，不替业务做判断）；
- 这是"软通知"，不会让 `ctx.write` 自动跳过。脚本无法写 `ctx.suspended`（只读），要让依赖缺失时停下写操作，只能在自己的判据里加业务标志位短路动作；框架没有声明式 `dependsOn` 硬挂起。

典型用法：

```js
const dep = await ctx.task.require('hppowersense', { timeout: 30000 });
ctx.log('info', `依赖已就绪：v${dep.version}（${dep.mode}）`);
ctx.watch.task('hppowersense', (state, info) => {
  if (state !== 'running') ctx.log('warn', '依赖异常，暂停业务裁决：' + info.reason);
});
```

## 工具接口

| 接口 | 说明 |
|---|---|
| `ctx.log(level, message, nodeId?)` | 结构化日志。`level`: `'info'` / `'warn'` / `'error'` |
| `ctx.sleep(ms)` | 等待毫秒（Promise） |
| `ctx.num(v)` | 数字转换，非数字 → 0。**仅用于明确想当 0 的场合**；"读不到"要用 `ctx.ha.num` 的 fallback 或先判 `ctx.invalid` |
| `ctx.invalid(v)` | 统一"无效状态"判定，返回布尔：`null` / `undefined` / 空串（含纯空格）/ `'unavailable'` / `'unknown'` / `'none'`（大小写、首尾空格不敏感）/ 数字 `NaN` 均为 `true`；合法枚举（`'on'`/`'Busy'`…）和数字为 `false`。**不对普通字符串做数字转换**，省得把枚举误判为无效 |
| `ctx.lock(keyOrFn, fn?)` | 防重入锁：传函数 = 默认单锁；传 `key, fn` = 多把独立锁。上次未结束返回 `false`（忙跳过，不排队） |
| `ctx.watch(entityIds, cb)` | 批量订阅，数组或单个 entityId，回调 `(nextObj, prevObj)` |
| `ctx.after(ms, fn)` | 可取消延时，返回定时器 id（对应 HA `for:` / `mode:restart` 语义） |
| `ctx.cancel(id)` | 取消定时器（after/every 通用），返回是否成功 |
| `ctx.every(ms, fn)` | 周期定时：固定频率反复触发，返回 id 用 `ctx.cancel(id)` 停止；stop 时自动清理、stopped 后不再触发。**仅用于固定频率兜底/清理**；到点触发优先 `ctx.after` 一次性重排（无漂移累积） |
| `ctx.keepAlive()` | **长驻脚本结尾必须调用**：`await ctx.keepAlive()` 让顶层协程永不结束（runner 不发 done、实例不被清理）。留一条"进入常驻模式"日志。一次性脚本不调用，自然结束即退出 |
| `ctx.time.today()` | `'YYYY-MM-DD'` |
| `ctx.time.nowSod()` | 当日秒数（与 HA `input_datetime.timestamp` 同口径） |
| `ctx.time.weekday()` | `'sun'` / `'mon'` / … / `'sat'` |
| `ctx.time.nowISO()` | ISO 时间字符串 |
| `ctx.time.formatSod(sod)` | 秒数 → `'HH:MM:SS'` |
| `ctx.stats()` | 写计数 `{ intent, sent, blocked }` |
| `ctx.dryRun` | 布尔 getter：当前是否影子模式（可热切换） |
| `ctx.stopped` | 布尔 getter：是否收到停止指令（**是属性不是函数**） |
| `ctx.suspended` | 布尔 getter：是否被兜底挂起（HA 断线 / 实体缺失） |

## ctx.hold — 通用「持续 N 秒确认」容器（优先用这个）

框架内置的状态机，把上一节手写的 `since/timer/翻转重置/到点复核` 全部封装。**实现"持续 N 秒"时优先 `ctx.hold`，只有它不适用时（如多组条件互锁需共享计时）才手写。**

```js
const h = ctx.hold(ms, opts?);   // ms > 0；opts 可省略
// opts:
//   initial   : 初始稳定值（默认 false）
//   condition : (raw) => signal，纯投影（可 async，可自己 await ctx.ha 读实体）；
//               不传时 signal = raw 本身
//   nodeId / label : 日志诊断
```

**数据流**：`raw`（脚本写入的值）→ `condition` 投影成 `signal` → signal 连续保持 `ms` → `stable` 翻转。

- `h.value`：同步读**稳定值**（翻转确认后的 signal，跨 realm getter 有效）。
- `h.value = x`：写 **raw**（当前值）。读写不同义：写入后不满 `ms` 读到的是旧稳定值。
- `h.watch((v, prev) => {...})`：只在**稳定值翻转**时通知（带新值/旧值）；返回 `off()` 可注销。
- `h.cancel()`：清定时器与 watcher，彻底停用（返回是否成功取消）。
- `h.state()`：`{ raw, signal, stable, since, active, remaining, ms, dead }` 诊断用。

**没有内置实体监听**：框架不订阅任何实体，`raw` 唯一入口就是 `h.value = x`。要基于 HA 实体判断，两种写法自己选：

```js
// ① 脚本自己订阅实体，在回调里算好值写进 raw（推荐：watch 与 projection 分离，逻辑最清晰）
const high = ctx.hold({ ms: 3000, condition: (raw) => raw > 800 });
ctx.watch([pWok, pOven, pRice], async () => {
  const sum = (await ctx.ha.num(pWok)) + (await ctx.ha.num(pOven)) + (await ctx.ha.num(pRice));
  high.value = sum;                 // 三路功率和 → raw
});

// ② condition 里自己读 HA（raw 可只当触发信号，甚至不用）
const stove = ctx.hold({ ms: 30000, condition: async () => (await ctx.ha.state('binary_sensor.stove')) === 'Busy' });
stove.value = true;                 // 任意一次赋值触发首次判定，此后到点复核会再读 HA

// ③ 纯脚本内值（非 HA 来源）：跟踪 'Busy' 这个枚举持续 30s，无需 condition
const mode = ctx.hold(30000);
mode.value = 'Busy';
const stable = mode.value;          // 同步读，满 30s 才是 'Busy'
```

- 只有 `h.value = x` 会触发重评；实体变化若没写进 hold 的 raw，不会推进它的计时。
- `condition` 抛错：本轮跳过、不推进计时，保守处理。

**边界（重要）**：

- 内部状态是**纯内存闭包**，不存 global/local。影子模式下 `ctx.global.set` 写影子桶、`get` 读正式桶，"写后自己读回"读不到——所以 hold 绝不能把计时状态放上下文。
- **重启不续计时**：重启后从初始值重新判定，符合"计时起点是纯过程量"的存储分层规范。
- 多组独立判据：每次 `ctx.hold()` 返回独立闭包，各自持有 `signal/since/timer`，天然隔离。
- 一个脚本内多个 hold 可用 `.value` 互相组合（读另一个 hold 的稳定值），但 `condition` 里这么用需留意求值时序；跨脚本共享仍走 `ctx.global`。
- 句柄的 `value` 是可读写 accessor，conv 桥接会搬运 setter（`ctx.dryRun` 这类只读 getter 不受影响）。

## 「持续 N 秒」的手写模式（仅 ctx.hold 不适用时）

`ctx.after(ms, fn)` 只是**一次性可取消延时**，框架不会帮你做状态机。若多组条件互锁、`ctx.hold` 不够用，才自己实现成滑动窗口：

`ctx.after(ms, fn)` 只是**一次性可取消延时**，框架不会帮你做状态机。"条件持续 N 秒"必须自己实现成滑动窗口：

1. 保存起点 `since` 与定时器 id `timer`；
2. 条件**首次满足**时才排 `ctx.after(N, ...)`；
3. 每次实体变化（`ctx.watch`）都重新重算判据：
   - 仍满足 → 不动计时器（继续累计）；
   - **不再满足 → 立即 `ctx.cancel(timer)`、`since = 0`**（中断即清零，下次满足从 0 开始）；
4. 定时器到点回调里**再读一次实体复核条件仍成立**，才执行动作；防止最后一次实体推送后状态已变但没再触发 watch。
5. 多组判据各用一套 `since/timer`，别共用。

```js
let since = 0, timer = null;
async function evaluate() {
  const cond = await readCond();                  // 每次重新读实体
  if (cond) {
    if (!since) {
      since = Date.now();
      timer = ctx.after(N, async () => {
        timer = null;
        if (await readCond()) onConfirm();        // 到点复核
      });
    }
  } else {
    since = 0;
    if (timer) { ctx.cancel(timer); timer = null; } // 翻转即重置
  }
}
ctx.watch(ids, () => { evaluate(); });
```

**反例（禁止）**：首次满足时排一个定时器，到点只检查一次就触发；中间条件翻转或实体变化从不重置。这会把"断断续续累计 N 秒"误判为"连续 N 秒"。

**重置粒度**：只认**判据结果翻转**（如"功率和 >800W"变为"≤800W"），不是实体任何数值抖动都重置。PWM 类功率传感器在窗口内反复波动但判据仍成立时，不应重置计时；否则持续时长永远凑不满。`ctx.every` 只做固定频率兜底，不用于持续时长判定。
