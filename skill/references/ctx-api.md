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
| `getState` | `await ctx.ha.getState(entityId)` | 完整状态对象 `{ entity_id, state, attributes, ... }`；实体不存在或 HA 断线返回 `null` |
| `state` | `await ctx.ha.state(entityId)` | 只返回 `state` 字符串（`'on'` / `'off'`…）；不存在返回 `null` |
| `num` | `await ctx.ha.num(entityId, fallback?)` | state 转数字；实体不存在返回 `fallback`（默认 0），state 非数字返回 0 |
| `getAttribute` | `await ctx.ha.getAttribute(entityId, attr, fallback?)` | 读属性（如 `hvac_action`、`timestamp`）；实体/属性缺失返回 `fallback`（默认 `null`） |
| `listEntities` | `await ctx.ha.listEntities(filter?)` | 列出实体，`filter` 可选字符串过滤 |
| `callService` | `await ctx.ha.callService(domain, service, data)` | HA 服务调用。**只允许写在 `ctx.actions` 注册的函数体内** |
| `onStateChange` | `ctx.ha.onStateChange(entityId, cb)` | 订阅变化。回调签名固定 `(nextObj, prevObj)` 两个**完整状态对象**，要字符串取 `nextObj.state` |
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
| `ctx.num(v)` | 转 NaN 为 0 的数字转换 |
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
