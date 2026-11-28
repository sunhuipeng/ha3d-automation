# ctx API 完整参考

ctx 是脚本唯一能访问的宿主能力。所有 HA 调用经白名单转发执行。

> **阅读顺序建议**：先读 §0 约束与 §1「先选存储层」（决定数据放哪），再按需要查具体接口。每个接口都标注**参数**与**返回值**；简单接口不举例，复杂接口附可运行片段。

## 目录

- §0 约束：禁用清单 / 内建 / 约定
- §1 存储分层与上下文（global / local / watch 家族 / 写者章踩坑）
- §2 HA 状态读写（entity / state / num / attr / attrs / listEntities / callService / change）
- §3 动作与写入口（actions / write）
- §4 脚本间联动与依赖（scriptId / task / call / params）
- §5 定时与并发（watch / after / cancel / every / sleep / keepAlive / gate / lock）
- §6 响应式值单元（ref / hold / 手写持续模式）
- §7 工具与运行时（log / num / invalid / time / stats / dryRun / stopped / suspended）

---

## §0 约束

### 0.1 静态校验禁用清单（提交时 AST 校验，报错带行号）

| 类别 | 禁止内容 |
|---|---|
| 标识符 | `require`、`process`、`globalThis`、`eval`、`Function`、`module`、`exports`、`__dirname`、`__filename`、`Buffer`、`fetch`、`XMLHttpRequest`、`WebSocket`、`importScripts`、裸 `global`（`ctx.global` 例外） |
| 语句 | `import` / `export` / 动态 `import()` |
| 模块访问 | `fs` / `net` / `http` / `https` / `child_process` / `os` / `path` / `vm` / `dns` / `tls` |
| 成员访问 | 任何对象的 `.constructor` / `.__proto__` / `.prototype` / `.call` / `.apply` / `.bind`（含 `obj['constructor']` 写法）；**唯一例外：`ctx.call`（`ctx` 直接下属，`ctx['call']` 亦可）** |

### 0.2 可用内建

`Math` / `Date` / `JSON` / `Promise` / `console.log` / `console.error` / `setTimeout` / `clearTimeout` / `setInterval` / `clearInterval`

### 0.3 全局约定

- **单写者约定**：每个 `ctx.global` key 只有一个权威写者，身份落盘；被其他脚本写入记告警但不拒绝（软约束）。
- **影子与开发模式正交**：`ctx.dryRun`（通道身份，影子/正式）与 `HA3D_DEV_MODE`（环境写拦截）互不影响。影子写上下文落 `shadow` 桶、正式落 `production`；`ctx.global` 读统一读 `production`，`ctx.local` 读自己的通道桶。
- **回调同步上限**：订阅/定时器回调的同步部分受 vm timeout 中断（默认 2000ms），异常记日志不冒泡。

---

## §1 存储分层与上下文

### 1.1 先选存储层：按消费者，不按重要性

写脚本前先判"**谁要用这个数据**"，再决定存哪里。**不要因为一个值"重要"就塞进全局**。

| 数据特征 | 存哪里 | 例子 |
|---|---|---|
| **另一个脚本要读或写**（跨脚本共享的事实/状态/裁决结果） | **`ctx.global`** 全局上下文 | `home.highPower`（m7 产出、audr76je 消费）、`waterHeater.avoiding` / `pendingStart` |
| **只有本脚本读，但服务重启后要恢复上次状态** | **`ctx.local`** 本地上下文（按 `脚本id:通道` 隔离） | 阶段标记、上次的加热目标记录 |
| **只有本脚本读，重启后可重算/归零无所谓** | **脚本内普通变量 / `ctx.ref`**（内存） | `since` / `timer`、`expected` 防自发自收表 |
| **人要改、人要看的配置** | **HA 实体**（`input_number` / `input_boolean` / `input_datetime`），**不进上下文** | 目标水温、动态开启时间 |

补充规则：

1. **全局 key 带业务前缀**（如 `home.highPower`），值形态（布尔/对象字段）先定契约；改形态必须同步所有消费者。
2. **私有状态不镜像 HA**：本项目自用的运行时状态不要为了"看着统一"去建 HA helper 实体；只有 HA 侧确实有外部消费者时才单向输出。
3. **影子读不隔离的后果**：影子实例 `ctx.global.set` 写 shadow 桶，但 `get` 读 production 桶——"影子写、自己读回"不成立。需要立刻读回自持的状态用内存变量，影子写入以日志为验证依据。
4. **跨脚本读写用 `ctx.lock` 防并发环**；本脚本自己产生、自己消费的持久化状态用 `ctx.local.watch` 驱动重评。
5. **写 `ctx.global` 键的脚本（事实源/写者）启动必须无条件写一次基线**：详见 §1.5 踩坑专节。

### 1.2 上下文接口总表

| 接口 | 参数 | 返回值 |
|---|---|---|
| `await ctx.global.get(key, fallback?)` | `key`: 键名（建议带业务前缀）；`fallback`: 键不存在时的值（缺省 `undefined`） | `Promise<any>`：键存在返回值（JSON 反序列化后的副本），否则返回 `fallback`。**所有实例一律读 `production`** |
| `await ctx.global.set(key, value)` | `value`: 任意可 JSON 序列化值 | `Promise<{ ok:true, scope:'global', key }>`：写入按调用者模式隔离（影子→`shadow`、正式→`production`）。**同值 set 不触发 watch，但仍会盖章** |
| `ctx.global.watch(key, cb, opts?)` | `cb`: `(value, prev, info)`；`opts`: `{ debounceMs? }`（写者失效防抖，缺省 5000） | 返回 `off()`（幂等取消订阅）。**默认回放**；只订阅 `production` |
| `await ctx.local.get(key, fallback?)` | 同上 | `Promise<any>`：读**自己通道**的桶（影子读 `sid:shadow`、正式读 `sid:production`），与 global 的读不隔离不同 |
| `await ctx.local.set(key, value)` | 同上 | `Promise<{ ok:true, scope:'local', key }>` |
| `ctx.local.watch(key, cb)` | `cb`: `(value, prev, info)` | 返回 `off()`（幂等）。**默认回放**；脚本内闭环，无跨脚本订阅/写者章/防抖 |

`key` 校验规则：`^[A-Za-z0-9_.:-]{1,128}$`，非法抛错。值必须可 JSON 序列化。

### 1.3 ctx.global.watch — 跨脚本共享桶（双源同回调）

**触发源两类，靠 `info` 区分**：

| 事件 | `info` | `value` / `prev` |
|---|---|---|
| 值变化（含回放） | `{ key, writerSid, namespace, source? }`，回放时 `source='replay'`、`prev=null` | 真实值 |
| 写者状态 | `{ key, writerSid, namespace, type:'writerState', state, reason }` | `value = prev` = 当前存量值（不能当成"值变了"） |

**回放语义**：注册时异步拉 `{v, w, ws}`（值+写者+写者状态）。桶有值立即回调一次（`prev=null`、`source='replay'`）；桶无值不回调（fallback 场景留给 `get`）；回放值未到达前已有真实事件则丢弃回放。**写者状态折叠**：写者实例状态变化（started/stopped/error/paused）折叠进同一回调，非 running 持续 `debounceMs` 才上报 down（到点向宿主复查，漏收恢复事件时静默复位），恢复 running 立即上报并取消计时；注册时写者已非 running 同样过防抖。写者状态看的是**正式实例**（影子写 shadow 桶不影响正式读者）。

**案例：事实 + 写者健康单通道消费**（audr76je 迁移后的真实写法）

```js
const off = ctx.global.watch('home.highPower', (value, prev, info) => {
  if (info.type === 'writerState') {
    // 依赖健康：state='running' 恢复 / 其他=失效；value=prev=存量值，绝不当 highPower 事实
    if (info.state === 'running') depHealthy = true;
    else { depHealthy = false; forcedByDep = true; }
    requestEvaluate('写者状态');
    return;
  }
  if (info.source === 'replay') lastPowerFact = value === true; // 基线裁决
  else lastPowerFact = value === true;                          // 后续通知
  requestEvaluate('highPower 通知');
}, { debounceMs: 5000 });
// 不再需要时 off()
```

回调内可继续 `set`（跨实例互写要自行用 `ctx.lock` 防循环）；写者自己不收到自己写的回调。

### 1.4 ctx.local.watch — 脚本内闭环（默认回放）

**事件来源只有两个**：本 runner 的 `ctx.local.set`、仿真注入（`inject_context scope=local`）。无跨脚本订阅、无写者章、无防抖。`info = { key, scope:'local', source:'set'|'replay' }`；同值 `set` 不触发；真实事件先到丢弃在途回放值。

**案例：持久化状态驱动重评**（替代手写"set 完再手动调一次评估"）

```js
// 写者：补烧达标标记，watch 自动驱动后续裁决
ctx.local.watch('bath.doneDate', (v, prev, info) => {
  if (info.source === 'replay') ctx.log('info', '恢复：当日达标=' + v);
  requestEvaluate('达标标记变化');
});
await ctx.local.set('bath.doneDate', ctx.time.today()); // 自动触发上面的 watch
```

### 1.5 踩坑：写者脚本必须无条件写启动基线（m7orioe9 2026-11-28）

凡是**负责写某个 `ctx.global` 键**的脚本（该键的事实源/权威写者），启动段必须**无条件**写一次基线：

```js
let state = false;                        // 内存默认值，仅作起点
// ... 从 HA 或历史值恢复出 state ...
await ctx.global.set(GLOBAL_KEY, state);  // ✅ 无条件：不看 hasSeed、不看值是否变化
```

**踩过的坑（m7orioe9 v1）**：

```js
let state = false;
const hasSeed = await ctx.global.get(GLOBAL_KEY) != null;
if (!hasSeed) await ctx.global.set(GLOBAL_KEY, false);  // ❌ 全局键已有历史值时永远跳过
```

表现：脚本重启后读到历史值 `false`，`hasSeed=true` 跳过 `set`，**写者章 `writers[GLOBAL_KEY]` 始终建立不起来**。消费方（如 audr76je）用 `global.watch(..., {debounceMs:5000})` 监听写者状态时，因存储层没有写者章，折叠通道无从派发，`info.type='writerState'` 的失效事件永远不来——依赖失效监管整段形同虚设。初次运行时若 `state === next` 被幂等判断拦掉，同样不建章。**"值是对的"不等于"章是有的"**：章只在 `set` 调用时落盘。

**为什么无条件写是安全的**：框架 `context.js` 的 `set` 是**先盖章 `writers[k]=sid`，再判值变化才发 change 事件**。所以同值 `set` 照样盖章（正是我们要的），但不会向订阅者误发值变化（不会误触发消费者裁决）。写基线是为了建章，不是为了改值。

**两个边界**：
- 影子实例写 `shadow` 桶、正式实例写 `production` 桶；消费方统一读 `production`，所以章必须等**正式实例**启动写才落地——影子验证阶段看不到生产桶的章是正常的，发布后才生效。
- 基线值形态（boolean/对象）先定契约；无条件写会把内存里的形态原样落盘，历史值是旧形态时会在启动那一刻触发一次 change，改形态必须同步所有消费者。

### 1.6 watch 家族回放语义对比（注册瞬间会不会收到回调）

| 接口 | 注册即回放？ | 回调参数 | 备注 |
|---|---|---|---|
| `ctx.global.watch(key, cb, opts?)` | **是**（桶有值时） | `(value, null, info)`，`info.source='replay'`、`info.writerSid`=存储写者 | 桶无值不回放；真实事件先到丢弃回放值；写者状态事件 `info.type='writerState'` 走同一回调 |
| `ctx.local.watch(key, cb)` | **是**（桶有值时） | `(value, null, info)`，`info.source='replay'` | 脚本私有桶、runner 内闭环；同值 `set` 不触发；无写者章/健康防抖 |
| `ctx.ref(v).watch(cb, opts?)` | **否**（`{immediate:true}` 可开） | `(value, null, info)`，`info.source='replay'` | 初始值在创建处已知；要"先跑一遍"直接读 `a.value` 或开 immediate |
| `ctx.watch(entityIds, cb, opts?)`（实体订阅） | **否** | `(nextObj, prevObj, extra)` | 只在实体变化时触发；启动基线自己 `ctx.ha.state/entity` 拉；**缺省 300ms 尾沿防抖合并**（同波多实体只回调一次，`extra={merged, entityIds}`；`debounceMs:0` 逐事件，`extra`=实体 id） |
| `ctx.hold` 的 watch 回调 | **否** | `(satisfied, prev, info)` | 只在状态切换时通知；初始态由 `initial` 决定 |

统一心智：**global/local.watch 注册即知道"现在是什么"**；实体订阅与 hold 只报"变化"，基线自己拉；ref 私有值初始态天然已知。三者都遵守"真实事件先到则丢弃在途回放值"。

---

## §2 HA 状态读写

### 2.1 读取接口

| 接口 | 参数 | 返回值 |
|---|---|---|
| `await ctx.ha.entity(entityId)` | `entityId`: 实体 id 字符串 | 完整状态对象 `{ entity_id, state, attributes, friendly_name? }`；实体不存在或 HA 断线返回 `null` |
| `await ctx.ha.state(entityId)` | 同上 | **原样**返回 `state` 字符串（`'on'` / `'unavailable'`…），有效性由脚本用 `ctx.invalid` 判；不存在返回 `null` |
| `await ctx.ha.num(entityId, fallback?)` | `fallback`: 读不到时的返回值（默认 `0`；传 `null` 表示跳过、传数值表示安全默认） | state 转数字；**实体缺失/状态无效/非数字串**三种情况都返回 `fallback` |
| `await ctx.ha.attr(entityId, key, fallback?)` | `key`: 属性名（如 `timestamp`）；`fallback` 默认 `null` | 单个属性值；实体/属性缺失返回 `fallback` |
| `await ctx.ha.attrs(entityId, fallback?)` | `fallback` 默认 `null` | 整个 `attributes` 对象；实体缺失/无属性返回 `fallback` |
| `await ctx.ha.listEntities(filter?)` | `filter`: 可选子串，按 entityId 与 friendly_name 过滤（大小写不敏感） | 实体数组 `[{ entityId, state, attributes, friendly_name }]` |
| `ctx.ha.change(entityId, cb)` | `cb`: `(nextObj, prevObj)` 两个完整状态对象；要字符串取 `nextObj.state` | **无返回值**（框架内部订阅表；没有 off，stop 时统一清理） |

**案例：保守读取与属性时间戳**

```js
const s = await ctx.ha.entity(ID.startTime);
if (!s) return 20 * 3600 + 30 * 60;                       // 实体缺失 → 默认 20:30
const sod = s.attributes && typeof s.attributes.timestamp === 'number'
  ? ctx.num(s.attributes.timestamp)
  : (() => { const p = String(s.state || '').split(':').map(Number);
             return (p[0]||0)*3600 + (p[1]||0)*60 + (p[2]||0); })();

const temp = await ctx.ha.num(ID.temp, null);   // 读不到 → null，让判据短路，不能当 0 推进
if (ctx.invalid(await ctx.ha.state(ID.wh))) return; // 断线保守分支
```

### 2.2 写入接口

| 接口 | 参数 | 返回值 |
|---|---|---|
| `await ctx.ha.callService(domain, service, data)` | `domain`/`service`: HA 服务域与名；`data`: 服务参数对象（含 `entity_id`） | `Promise<any>`：正常返回 HA 调用结果；被拦截时返回 `{ skipped:true, reason, domain, service, entityId }`（`reason` 枚举见下）。**业务写一律走 `ctx.write`，不裸调此接口** |

`callService` 的 skipped 分支（都 `reply(true, ...)` 不 reject，脚本要自己看 `skipped` 字段判断写是否真生效）：

| 场景 | 回执特征 |
|---|---|
| 实例已停止（2026-11-28 补的执行器侧硬闸，宽限期内裸调也拦） | `{ skipped:true, reason:'实例已停止', ... }` |
| 影子模式 | `{ shadow:true, skipped:true, ... }`（无 `reason`） |
| 全局开发模式 | `{ devMode:true, skipped:true, ... }`（无 `reason`） |
| HA 断线 / 依赖实体缺失已暂停 | `{ skipped:true, reason:'HA 断线'｜'依赖实体缺失已暂停', ... }` |
| 动作互斥/冷却冲突 | `{ skipped:true, reason:冲突原因, ... }` |
| HA 下发失败（断线/超时） | `{ skipped:true, reason:'HA 下发失败', error, ... }` |

### 2.3 实体订阅（批量，内置防抖合并）

| 接口 | 参数 | 返回值 |
|---|---|---|
| `ctx.watch(entityIds, cb, opts?)` | `entityIds`: 单个 id 或 id 数组；`cb`: `(nextObj, prevObj, extra)`；`opts.debounceMs` | **无返回值**（内部转发 `ctx.ha.change`；框架注册不回放，启动基线自己拉） |

**防抖合并（2026-11-28 下沉框架）**：`opts.debounceMs` **缺省 300**，`0` 关闭回逐事件回调。语义是**尾沿防抖**：窗口由第一个事件开启，窗口内的后续事件只吸收（更新待发状态、计数、实体集合），**300ms 静默后回调一次**；窗口关闭后的新事件开新窗口。场景：HA 模板实体与本体同波各发一次 `state_changed`（如 water_heater 属性变化 + 模板温度传感器重算）、一秒内多个实体同时刷新——旧行为是逐事件回调导致重复评估/日志刷屏，现在同批变化天然合并为一次。

回调第三参 `extra`：

- **防抖开启（缺省）**：`info = { merged, entityIds }`——窗口内合并的事件数、去重后的触发实体 id 列表；
- **`debounceMs: 0`**：逐事件回调，`extra` 为触发实体 id 字符串（与 `ctx.ha.change` 直订同款）。

**合并时 `(nextObj, prevObj)` 是最后一个事件的前后值**（不同实体的 prev 拼在一起无意义），要完整现状请在回调里自己拉。防抖计时走受控定时器：仿真 `advance` 可推动、stop 自动清理。

**案例**：

```js
// 同波多实体推送合并为一次评估（缺省 300ms）
ctx.watch([ID.temp, ID.kw, ID.wh], () => requestEvaluate('实体推送'));

// 想知道这波是谁触发的
ctx.watch([ID.temp, ID.wh], (s, p, info) => {
  ctx.log('info', `变化来源 ${info.entityIds.join(',')}（合并 ${info.merged} 条）`);
});
```

---

## §3 动作与写入口

### 3.1 ctx.actions + ctx.write

```js
ctx.actions({ 动作名: (…args) => {…}, ... })            // 注册：重复注册抛错；无返回值
const ok = await ctx.write(op, desc, nodeId, ...args)    // 唯一写入口
```

`ctx.write` 参数：

| 参数 | 含义 |
|---|---|
| `op` | 动作名，必须已注册（未注册抛错） |
| `desc` | 日志描述文案 |
| `nodeId` | 关联画布节点 id（`n_xxx`）：**位置参数，不可省略**（省略会让 `...args` 前移错位）。日志按节点结构化落盘，并驱动前端画布运行态高亮（error 红/其余绿） |
| `...args` | 透传给动作函数的参数 |

返回值：`Promise<boolean>`——`true`=真实执行；`false`=被拦截（挂起/影子/开发模式）。

**行为顺序**：动作未注册→抛错；`ctx.stopped`→跳过返回 false；挂起（`ctx.suspended`）→记 `[兜底]` 返回 false；影子→记 `[影子·拦截写操作]` 返回 false；开发模式→记 `[开发模式·拦截写操作]` 返回 false；正常→执行动作、记 `[真实写操作]` 返回 true。

**案例：定义动作并在业务里调用**

```js
ctx.actions({
  whOn:  () => ctx.ha.callService('water_heater', 'turn_on',  { entity_id: ID.wh }),
  whOff: () => ctx.ha.callService('water_heater', 'turn_off', { entity_id: ID.wh }),
  speak: (v) => ctx.ha.callService('text', 'set_value', { entity_id: ID.speaker, value: v }),
});
await ctx.write('whOff', '大功率规避关热水器', 'n_avoid');
await ctx.write('speak', '播报完成', 'n_announce_done', '热水器烧水完成啦，主人');
```

主进程 `callService` 有同样的两道闸（影子/开发模式），脚本绕过 `ctx.write` 直调也拦得住。MCP 直调 HA 不受开发模式限制（用户显式 confirmed）。

---

## §4 脚本间联动与依赖

### 4.1 ctx.scriptId / ctx.task — 依赖运行状态

任意脚本都能读自己的 id，也能查询/等待**另一个脚本实例**的运行状态。没有配置式 `dependsOn`，依赖写在脚本里。

> **`ctx.task.watch` 已删除（2026-11-28）**：依赖健康监控统一走 `ctx.global.watch` 的写者状态折叠（`info.type='writerState'`，`{debounceMs}` 防抖内建）。旧脚本调用会在运行时报错，请迁移。

| 接口 | 参数 | 返回值 |
|---|---|---|
| `ctx.scriptId` | —（字符串属性） | executor 注入的权威脚本 id |
| `await ctx.task.status(scriptId)` | `scriptId`: 被查脚本 id | `Promise<{ scriptId, version, mode, state, info }>`；查一次不等待 |
| `await ctx.task.require(scriptId, opts?)` | `opts.timeout`: 等待毫秒，缺省 30000 | 同上对象；等到**第一次** `running` 即 resolve；超时抛错；收到 stop 立即中断抛错 |

返回对象字段：

| 字段 | 含义 |
|---|---|
| `version` | 实际命中的实例版本（查不到实例时取该通道最新版本） |
| `mode` | 保留字段，恒 `'production'`（只读接口固定看正式实例，仅日志辨识） |
| `state` | `'running'` / `'paused'` / `'stopped'` / `'error'` |
| `info` | `{ scriptId, version, mode, reason }`，`reason` 说明来源（`queried`/`started`/`stopped`） |

**通道规则（读不隔离）**：一律看依赖的**正式实例**，与调用者影子/正式无关。影子实例在跑不算就绪；无正式实例返回 `stopped`。这些接口只读、无设备副作用，所以不做通道隔离。依赖不健康时的写操作短路由业务脚本自己负责。

**仿真口径**：`status` 读虚拟任务表（默认 `stopped`）、`require` 用 `inject_task` 造状态并可 `advance` 验超时。详见 `simulation.md` §4.4。

**案例**（依赖门闩 + 健康监控分工）：

```js
const dep = await ctx.task.require('m7orioe9', { timeout: 30000 }); // 启动门闩：等到 running
ctx.log('info', `依赖已就绪：v${dep.version}（${dep.mode}）`);
// 之后的健康监控交给 global.watch 写者折叠通道，不再订阅 task
```

### 4.2 ctx.call / ctx.params — 显式联动

| 接口 | 参数 | 返回值 |
|---|---|---|
| `await ctx.call(scriptId, params?)` | `scriptId`: 目标脚本/场景 id；`params`: 必须可 JSON 序列化 | 启动回执对象：正式 `{ id, version, mode:'production', started:true }`；影子/仿真 `{ id, version, mode:'shadow', started:true, mocked:true }`（被调方不执行）。只等启动、**不等执行完**；失败 reject |
| `ctx.params` | —（属性） | 被 `ctx.call` 触发时携带的入参；未被调用时为 `null` |

规则：只允许一次性脚本/场景（`kind=script/scene`），常驻 automation 不可调用；目标在跑默认拒绝（`restartable:true` 则停旧启新）；调用链最多 5 层。

**案例**：`await ctx.call('ngvgq6ln', { minutes: 30 });` —— 被调脚本开头 `const min = ctx.params?.minutes ?? 30;`

---

## §5 定时与并发

### 5.1 定时接口

| 接口 | 参数 | 返回值 |
|---|---|---|
| `ctx.after(ms, fn)` | `ms`: 延时毫秒；`fn`: 到点回调（受 stopped 闸与 vm timeout 保护） | 定时器 id（数字序号），交给 `ctx.cancel(id)` 取消。对应 HA `for:` / `mode:restart` 语义 |
| `ctx.cancel(id)` | `id`: `after`/`every` 返回的 id | 布尔：是否成功取消 |
| `ctx.every(ms, fn)` | `ms`: 周期毫秒；`fn`: 周期回调 | 定时器 id；stop 时自动清理、stopped 后不再触发。**仅用于固定频率兜底/清理**，不用于"持续 N 秒"判定 |
| `await ctx.sleep(ms)` | `ms`: 毫秒（负数/非数按 0） | `Promise<void>`；走虚拟时钟（仿真 advance 可快进）。**stop 时不再 resolve**（2026-11-28 改走 `scheduleTimer` 纳入 `timers` 注册表，清句柄后续体安静让步，不会在停止后继续做副作用） |
| `await ctx.keepAlive()` | — | 永不 resolve 的 Promise。**长驻脚本结尾必须调用**（runner 不发 done、实例不被清理）；一次性脚本不调用，自然结束即退出 |

**案例：一次性重排（无漂移累积）**

```js
let fireTimer = null, fireSod = null;
function armFire(startSod) {
  const now = ctx.time.nowSod();
  const next = startSod > now ? startSod : startSod + 86400;
  if (fireSod === next) return;                 // 同刻去重
  if (fireTimer) ctx.cancel(fireTimer);
  fireTimer = ctx.after((next - now) * 1000, () => {
    fireTimer = null; fireSod = null;
    requestEvaluate('到点触发');
  });
  fireSod = next;
}
```

### 5.2 ctx.gate — 事件驱动评估的合并门

| 接口 | 参数 | 返回值 |
|---|---|---|
| `ctx.gate()` | — | `gate` 句柄 |
| `gate.run(fn)` | `fn`: 异步评估函数（异常记 error 日志、不向外抛） | `Promise<boolean>`：`true`=立即执行；`false`=忙被合并 / 脚本已停止 |

**合并语义**：忙时多次调用只保留**最后一次** fn，其余静默丢弃——gate 只回答"现在是什么"，**不保证中间事件序列**；依赖事件序列的判据不能放 gate 里。与 `ctx.lock` 的区别：lock 忙**跳过**（不排队），gate 忙**合并**（不丢最后一次）。

**案例：watch 通知驱动的评估**（audr76je 真实写法）

```js
const evalGate = ctx.gate();
function requestEvaluate(reason) {
  return evalGate.run(async () => {
    try { await evaluate(reason); }
    catch (e) { ctx.log('error', `评估异常（${reason}）：${e?.message || e}`, 'n_eval'); }
  });
}
ctx.global.watch(POWER_KEY, (v, p, info) => requestEvaluate('m7 通知'));
ctx.watch([ID.temp, ID.wh], () => requestEvaluate('实体推送'));
```

### 5.3 ctx.lock — 防重入锁

| 接口 | 参数 | 返回值 |
|---|---|---|
| `await ctx.lock(fn)` | `fn`: 单锁回调 | `Promise<boolean>`：`true`=拿到锁并执行完；`false`=忙跳过（不排队） |
| `await ctx.lock(key, fn)` | `key`: 锁名字符串（多把独立锁）；`fn`: 回调 | 同上 |

**注意**：`ctx.lock` 是 async，判断忙跳过必须 `await`——直接 `const ok = ctx.lock(...)` 恒 truthy。

**案例**：`const ok = await ctx.lock('write', async () => { await doWrite(); }); if (!ok) return;`

---

## §6 响应式值单元

### 6.1 ctx.ref — 脚本内响应式值（内存，重启即失）

| 接口 | 参数 | 返回值 |
|---|---|---|
| `ctx.ref(initial?)` | `initial`: 初始值，缺省 `null` | `ref` 句柄：`.value` 可读写 accessor；`.watch(cb, opts?)` 返回 `off()` |
| `ref.watch(cb, opts?)` | `cb`: `(value, prev, info)`，`info={source:'set'|'replay'}`；`opts.immediate`: 打开回放 | `off()`（同一 ref 可多次 watch） |

**赋值判定**：与旧值相等则静默吞掉（标量严格相等、对象/数组按 JSON 结构比较）；不同才更新并按注册顺序同步派发。**默认不回放**（初始值创建处已知），要"先跑一遍"直接读 `a.value` 或开 `{immediate:true}`。stop 后赋值仍更新内部值，但不再触发 watcher。

**案例**：

```js
const a = ctx.ref(0);
a.watch((v, prev) => ctx.log('info', `变化：${prev} → ${v}`));
a.value = 1;                      // 触发
a.value = 1;                      // 同值：静默吞掉
a.watch((v, p, i) => ctx.log('info', '回放:' + v), { immediate: true }); // 立即回放当前值
```

**与 global/local.watch 分工**：ref 是进程内私有状态（不落盘、重启即失），适合"事件驱动的状态翻转"；跨脚本共享用 global.watch，本脚本持久化状态用 local.watch。

### 6.2 ctx.hold — 期待值/条件的双边迟滞确认器（优先用）

框架内置**二态状态机**，把"持续 N 秒"的 `since/timer/翻转重置/到点复核` 全部封装。实现"持续 N 秒"时优先 `ctx.hold`，只有多组判据互锁等不适用时才手写。

**构造参数**（只接受对象，旧语法 `ctx.hold(30000)`/`ms`/`condition`/`fallMs` 已删除，用了直接抛错）：

| 参数 | 含义 |
|---|---|
| `expect` | 二选一：期待值（raw 等于该值即满足）/ 期待条件 `(raw) => boolean`（只返回 truthy/falsy，不要 null 三态）；**条件函数可返回 Promise，框架会 `await`**，支持异步读 HA |
| `satisfyMs` | 必填 >0：满足期待持续多久后回调 true |
| `unsatisfyMs` | 可选：不满足持续多久后回调 false；`null`/`0`/缺省 = 立即回落 |
| `initial` | 可选：初始已确认状态，默认 false |
| `nodeId` / `label` | 可选：日志诊断 |

**句柄接口**：

| 接口 | 参数 | 返回值 |
|---|---|---|
| `h.value` | 写：当前 raw（唯一重评入口）；读：已确认状态（true/false） | — |
| `h.watch(cb)` | `cb: (satisfied, prev, info)`，`info={ satisfied, value, reason:'satisfied'|'unsatisfied', raw, expected, state, stable, ms, nodeId }` | `off()`；confirm 时回调一次 true / false，prev 是上次已确认状态 |
| `h.cancel()` | — | 布尔：是否成功取消（清定时器与 watcher、冻结状态；cancel 后 watch 只拿空 off） |
| `h.state()` | — | 诊断对象 `{ raw, desired, signal, state, stable, pending, since, active, remaining, ms, satisfyMs, unsatisfyMs, dead }`；`pending` 为 `'satisfied'|'unsatisfied'|null` |

**语义要点**：构造时立即判定一次（init）；此后 `h.value = x`、到点复核、异常后补排都会重跑 expect。中途翻转回当前状态只取消本轮计时、不回调；重新相反时从 0 重计。同一状态持续多久不重复回调。`expect` 抛错本轮跳过、按剩余时间自动补排重试。无内置实体监听——要基于 HA 实体判断，脚本自己 `ctx.watch` 写 raw 或在 expect 里读 HA。

**边界**：内部纯内存闭包、不存 global/local；重启不续计时；stop 自动清理（不必自己 cancel）。

**案例（三种典型来源）**：

```js
// ① 订阅实体 → 算好值写 raw（推荐：watch 与 projection 分离）
const high = ctx.hold({ expect: (raw) => raw > 800, satisfyMs: 3000, unsatisfyMs: 10000 });
ctx.watch([pWok, pOven, pRice], async () => {
  high.value = (await ctx.ha.num(pWok)) + (await ctx.ha.num(pOven)) + (await ctx.ha.num(pRice));
});
high.watch((satisfied) => { if (satisfied) ctx.write('setFlag', '大功率', 'n_write', true); });

// ② expect 里自己读 HA（raw 可只当触发信号）
const stove = ctx.hold({ expect: async () => (await ctx.ha.state('binary_sensor.stove')) === 'Busy',
                         satisfyMs: 30000, unsatisfyMs: null });

// ③ 纯脚本内值：期待 true 持续 30s 确认
const a = ctx.hold({ satisfyMs: 30000, expect: true, unsatisfyMs: null });
a.value = true;
```

### 6.3 「持续 N 秒」手写模式（仅 ctx.hold 不适用时）

`ctx.after` 只是一次性可取消延时，框架不做状态机。多组条件互锁、`ctx.hold` 不够用时才手写滑动窗口。**注意语义差异**：下面是 HA `for:` 单边语义（条件掉出立即清零）；`ctx.hold` 是双边迟滞，两者不互通。

1. 保存起点 `since` 与定时器 id `timer`；
2. 条件**首次满足**时才排 `ctx.after(N, ...)`；
3. 每次实体变化重算判据：仍满足→不动计时器；**不再满足→立即 `ctx.cancel(timer)`、`since=0`**；
4. 定时器到点回调里**再读一次实体复核条件仍成立**，才执行动作；
5. 多组判据各用一套 `since/timer`，别共用；
6. **重置粒度**：以判据结果翻转为准（如"功率和 >800W"变"≤800W"），不是实体任何数值抖动都重置。

**反例（禁止）**：首次满足排一个定时器，到点只检查一次就触发，中间翻转从不重置——会把"断断续续累计 N 秒"误判为"连续 N 秒"。`ctx.every` 只做固定频率兜底，不用于持续时长判定。

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

---

## §7 工具与运行时

### 7.1 日志与值转换

| 接口 | 参数 | 返回值 |
|---|---|---|
| `ctx.log(level, message, nodeId?)` | `level`: `'info'|'warn'|'error'`；`message`: 文本（字符串化）；`nodeId`: 可选画布节点 id | 无返回值；结构化落盘，`get_logs` 可读、前端画布高亮 |
| `ctx.num(v)` | `v`: 任意值 | number：数字转换，非数字 → 0。**仅用于明确想当 0 的场合**；"读不到"用 `ctx.ha.num(eid, fallback)` |
| `ctx.invalid(v)` | `v`: 任意值 | boolean：无效状态判定——`null`/`undefined`/空串（含纯空格）/`'unavailable'`/`'unknown'`/`'none'`（大小写与首尾空格不敏感）/ `NaN` 为 true；合法枚举（`'on'`/`'Busy'`…）与数字为 false。**不对普通字符串做数字转换** |

### 7.2 时间工具

| 接口 | 参数 | 返回值 |
|---|---|---|
| `ctx.time.today()` | — | `'YYYY-MM-DD'` |
| `ctx.time.nowSod()` | — | 当日秒数（与 HA `input_datetime.timestamp` 同口径） |
| `ctx.time.weekday()` | — | `'sun'` / `'mon'` / … / `'sat'` |
| `ctx.time.nowISO()` | — | ISO 时间字符串 |
| `ctx.time.formatSod(sod)` | `sod`: 秒数 | `'HH:MM:SS'` |

### 7.3 运行时属性

| 接口 | 返回值 |
|---|---|
| `ctx.stats()` | `{ intent, sent, blocked }` 写计数 |
| `ctx.dryRun` | boolean getter：当前是否影子模式（可热切换） |
| `ctx.stopped` | boolean getter：是否收到停止指令（**属性不是函数**） |
| `ctx.suspended` | boolean getter：是否被兜底挂起（HA 断线 / 实体缺失） |

**stop 让步的框架代劳边界**（2026-11-28 框架补齐）：stop 只置标志不强杀执行流，500ms 宽限期后 kill。框架**已统一**在各类回调派发入口挡 stopped，脚本不必再写重复检查：
- 实体订阅 `ctx.watch` / `ctx.ha.change` 回调、global/local 上下文 watch 回调（值事件 / 回放 / 写者状态）、`ctx.after` / `ctx.every` / 裸 `setTimeout` / `setInterval` 定时回调、`ctx.gate.run` / `ctx.ref` / `ctx.hold` 派发、`ctx.write` 动作、`ctx.task.require` —— 这些入口 stopped 后一律不触发 / 不执行。
- `ctx.sleep` 已纳入 `timers` 注册表，stop 时清句柄、不再唤醒续体。
- 执行器侧对裸 `ctx.ha.callService` 也有停止硬闸（宽限期内不下发，回 `{ skipped:true, reason:'实例已停止' }`，见 §2.2）。

因此**回调入口第一行**的 `if (ctx.stopped) return;` 属于冗余，新脚本不必写。**仍需脚本自己检查**的只有：长循环内、`await` 之后到下一次业务动作之间有多个同步步骤时（框架无法在续体中间插入检查）。写脚本时优先依赖框架闸，只在真正有长续体 / 循环的地方显式让步。
