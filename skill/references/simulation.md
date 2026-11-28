# 仿真验证（simulate）使用手册

> 设计依据：项目根 `SIMULATION-DESIGN.md`（§5 工具 / §7 断言 / §14 实现进度与实战记录）。
> 一句话：**仿真只是影子验证的第一段，不是流程终点**——`simulate` 用虚拟世界验流程/时序/写意图，跑完必须 `switch_verify_mode {"mode":"follow"}` 切回影子模式并让同一个影子版本真跑（`case.cjs finish <scriptId>` 一步完成），两段都过才允许 `publish`。

---

## 1. 什么时候用哪种模式

**固定顺序**：`5.1 simulate（第一段，秒级回归）→ 5.2 切回 follow → 5.3 follow 真跑（验收门禁）`。顺序不能倒、也不能只做第一段；`follow` 是默认常驻状态，`simulate` 是临时进入。

| | `follow`（影子模式，默认） | `simulate`（仿真） |
|---|---|---|
| 实体状态 | 真实 HA 当前值 | 虚拟实体表（种子 + 注入，`callService` 会回写并派发 `state` 形成闭环；**未进种子的实体** `callService` 时也会自动建表回写，但 `getState`/`listEntities` 读不到——判据要读的实体必须放种子） |
| 时钟 | 真实时间 | 虚拟时钟，只有 `advance` 才前进（不推进就永远不走） |
| `ctx.write` | 只记 `[影子·拦截写操作]`，不进流程 | 记**写意图**（`service` + `write` 两条），驱动流程继续 |
| 外部动作 | 不真实下发 | 不真实下发，`ctx.actions` 里的 HA 调用由 host 在微任务内应答 |
| 能验证 | 判据读得对不对、真实设备有没有动、真实回调时序 | 分支是否走到、防抖/冷却时长是否准、写序列与顺序对不对 |
| 不能验证 | 需等待真实时间，慢且不可控 | **设备不响应 / 失败 / 延迟等异常分支**（决策见报告 §14.7，不做 `loopback`） |
| 流程位置 | 5.3 验收门禁；也是仿真结束后的落点 | 5.1 第一段；跑完必须回 follow，不能停在这里 |

**职责边界（硬规则）**
- 仿真里**不造假失败**。需要看"设备没响应脚本怎么办"，把实例手动切到 `follow` 用真实设备跑。
- 仿真只覆盖本脚本，不联动其他脚本；依赖脚本的状态用 `inject_task` 造（各接口具体口径见 §4.4）。
- 仿真通过 ≠ 线上可用。`publish` 前必须在 `follow` 下用真实设备跑一轮（`publish` 守卫照旧）。

---

## 2. 前置条件

1. 服务在线：`curl http://localhost:8100/api/health`；本地只能用 `npm run start:dev` 起，禁止 `npm start` / `node server/index.js`。
2. **目标脚本得有影子版本**：正式版内容不可变，不能直接拿正式版进仿真。复制方式：
   ```bash
   # 用原来的 script/flow/icon/kind 提交一个影子新版本（v3 → v4）
   node skill/tools/mcp-call.cjs automation_submit_script '{"scriptId":"<id>","name":"<原名>","script":"<源码>","flow":{...},"channel":"shadow","newVersion":true,"kind":"automation","confirmed":true}'
   node skill/tools/sync-cache.cjs --force
   ```
   校验复制是否干净：`script.js` 的 sha256 应与原版一致（`flow.json` 允许自动布局差异）。
3. 种子里的 `entity_id` 必须真实存在（`automation_list_entities` / `automation_get_state` 核对），状态枚举大小写照抄真实值（`Off` / `off` / `unavailable` 不能猜）。
4. 时间型脚本把起点选在**业务窗口边界**（如 `input_datetime` 的开启时刻），别随手取当前时间。

---

## 3. 工具一览（11 个仿真工具 + 1 个切换入口，全部需 `confirmed:true`）

| 工具 | 关键参数 | 用途 |
|---|---|---|
| `automation_switch_verify_mode` | `mode`（follow/simulate）、`startAt?`、`seed?` | 唯一切换入口。内部走「暂停旧实例 → 等真正退出 → 以目标模式启动」，不热切；正式实例不受影响 |
| `automation_sim_inject` | `payload.{entity\|context\|task\|suspend}` | 注入一次变化：实体（先改虚拟表再触发订阅）/ 上下文 / 依赖任务态 / 挂起 |
| `automation_sim_advance` | `ms` | 快进虚拟时钟；到点定时器按 dueAt 顺序触发 |
| `automation_sim_run_steps` | `steps[]`、`startAt?`、`seed?`、`continue?`、`failFast?` | **批量跑完整用例 + 逐步断言**，回归首选 |
| `automation_sim_assert` | `writes/noWrites/state/context/logs/expect`、`since?`、`label?` | 对当前会话单次断言（不推进、不重建） |
| `automation_sim_snapshot` | `since?`、`include?`、`entityScope?` | 取快照：clockNow/seq、logs、**writes（硬证据）**、entities、context、execution/timers/watchers |
| `automation_sim_mark` | `name?` | 给世界打标记（实体/上下文/task） |
| `automation_sim_rewind` | `mark` | 回到标记点的**数据**（时钟与脚本状态不回退） |
| `automation_sim_export` | `name` | 导出回归用例 → `skill/.fixtures/<id>/<name>.json` |
| `automation_sim_run_fixture` | `name?`、`assertWrites?`、`failFast?` | 重放用例；不给 `name` 则只列已有用例 |
| `automation_sim_close` | — | 结束仿真实例、销毁虚拟世界；`follow` 模式下拒绝（用 `stop_script`）。**不做收尾用**：它不会回 follow，正常收尾用 `case.cjs finish` / `switch_verify_mode {"mode":"follow"}` |

HTTP 等价物：`POST /api/script/:id/verify-mode`（body `{mode,startAt,seed}`）。

---

## 4. 三条工作流

三条都发生在 `SKILL.md` 第 5 步的 **5.1 节点**内；跑完任何一条都要接 **5.2 `case.cjs finish`**（切回 follow），否则验证链没闭合。按脚本行为清楚程度选：

### 4.1 交互式探查（一步步来，适合摸不清脚本行为时）

```bash
# ① 切仿真 + 种子（实体初始值 + 需要的上下文）
node skill/tools/mcp-call.cjs automation_switch_verify_mode '{
  "scriptId":"<id>","mode":"simulate","startAt":"2026-11-26T20:50:00+08:00",
  "seed":{"entities":{"sensor.x":{"state":"0"}},"context":{"global":{},"local":{}}},
  "confirmed":true}'

# ② 看启动瞬间做了什么（写意图 + 日志 + 在等什么）
node skill/tools/mcp-call.cjs automation_sim_snapshot '{"scriptId":"<id>","include":["writes","logs","context","execution"],"confirmed":true}'

# ③ 推进 / 注入，再取增量快照（since = 上次 seq，不漏不重）
node skill/tools/mcp-call.cjs automation_sim_advance '{"scriptId":"<id>","ms":3000,"confirmed":true}'
node skill/tools/mcp-call.cjs automation_sim_snapshot '{"scriptId":"<id>","since":<上次seq>,"include":["writes","logs"],"confirmed":true}'
```

节奏建议：**每次只推进到下一个判据边界前后**（如 2999 / 3000ms），先看 `writes` 再下结论。

### 4.2 批量用例（推荐，一次跑完 + 断言）—— case.json DSL 完整说明

```bash
node skill/tools/mcp-call.cjs automation_sim_run_steps "$(cat case.json)"
```

一个完整用例（先验启动静默，再验 3 秒窗口边界两边的写意图）：

```json
{
  "scriptId": "<id>",
  "startAt": "2026-11-26T20:50:00+08:00",
  "seed": { "entities": { "sensor.p": { "state": "100" } }, "context": { "global": {} } },
  "steps": [
    { "op": "assert", "label": "启动无写", "noWrites": true },
    { "op": "inject_entity", "entityId": "sensor.p", "state": "1200" },
    { "op": "advance", "ms": 2999 },
    { "op": "assert", "label": "2999ms 不写", "noWrites": true },
    { "op": "advance", "ms": 1 },
    { "op": "assert", "label": "3000ms 写 true", "writes": [{ "op": "setFlag", "args": ["n_w", true] }] }
  ],
  "confirmed": true
}
```

#### 顶层字段

| 字段 | 必填 | 含义与用法 |
|---|---|---|
| `scriptId` | ✅ | 目标脚本 id；目标必须已有影子版本（正式版不可仿真，见 §2 前置条件 2） |
| `startAt` | — | 虚拟时钟起点，ISO 带时区。缺省 = 当前真实时刻。时间型脚本建议取**业务窗口边界**（如 `input_datetime` 的开启时刻），别随手取当前时间 |
| `seed` | — | 初始虚拟世界。`seed.entities`：`entity_id → {state, attributes?, friendly_name?}`，entity_id 必须真实存在、枚举大小写照抄（`Off`/`off`/`unavailable` 不能猜）；`seed.context`：`{global:{}, local:{}}` 预置上下文 |
| `steps` | ✅ | 驱动 + 断言流水，按序逐条执行，op 见下表 |
| `continue` | — | 缺省 `false`：**每次重建虚拟世界**（`startAt/seed` 生效，用例可独立重跑）；`true`：在当前会话续跑，此时**不能再传 `startAt/seed`**（二者互斥，服务端会报错） |
| `failFast` | — | 缺省 `false`：断言失败**不中断**，收集全部失败点一次看完；`true`：首个失败的 assert 即停 |
| `confirmed` | ✅ | MCP 写操作安全确认，恒为 `true` |

#### steps[] 的 op 一览（每条形如 `{op, ...参数}`）

- 未知 `op` 报错并**中断整次执行**（返回 `aborted:true`，后面步骤不再跑）；非断言步骤抛异常同样中断。断言失败默认只收集、不中断（`failFast:true` 才停）。

| op | 字段 | 含义与用法 |
|---|---|---|
| `advance` | `ms` | 推进虚拟时钟，到点定时器按 dueAt 顺序触发。**时钟只有 advance 才前进**，不推进就永远不走；`ms` 是虚拟毫秒。节奏：每次只推进到下一个判据边界前后（2999 / 3000） |
| `inject_entity` | `entityId`、`state?`、`attributes?`、`friendly_name?` | 注入一次实体变化：**先改虚拟表再触发订阅回调**（脚本 `ctx.watch` 会收到"状态变了"）。`state` 枚举大小写照抄真实值 |
| `inject_context` | `scope?`（global/local，**缺省 local**）、`key`、`value`、`writer?` | 写虚拟上下文桶；**两种 scope 都派发 `contextChange`**（2026-11-28 补齐 local 分支）：`scope:'global'` 进 `global.watch`，`scope:'local'`（缺省）进 `ctx.local.watch`。模拟**跨脚本**通知必须显式写 `"scope":"global"`；要驱动本脚本 `local.watch` 用 local（缺省）。`writer` 仅对 `global` 有效，为该 key 盖写者章（对齐单写者约定）——盖了章的 key，`inject_task` 改写者状态时会折叠派发 `contextWriterState`；不盖章则写者未知、不派发写者状态 |
| `inject_task` | `scriptId`、`state`（`running/stopped/error/paused`） | 造"依赖脚本"的任务态。仿真不联动其他脚本，依赖其状态只能这样造。对**已盖章写者**的 key 同时派发 `contextWriterState`（runner 侧防抖后进同一回调） |
| `inject_params` | `params` | 覆盖触发参数。**仅在下一次进入 simulate 时生效**，运行中注入只在快照可见并记 warn 日志 |
| `inject_suspend` | `suspend?`（缺省 `true`） | 模拟实例挂起；传 `false` 表示恢复 |
| `snapshot` | `since?`、`include?`、`entityScope?` | 用例中途留证据（字段同 §3 `sim_snapshot`），结果挂在 `results[i].snapshot` |
| `mark` | `name?`（缺省 `m<序号>`） | 给世界**数据**打标记（实体 / 上下文 / task） |
| `rewind` | `mark`（或 `name`） | 世界数据回滚到标记点。**时钟与脚本内部状态（定时器、keepAlive、已执行的续体）不回退**——要完全重放请重建世界或用 4.3 fixture 重放 |
| `assert` | 见下表 | 断言。断言完成后游标推进，下一段断言只看新增 |

#### assert 字段（各字段之间 AND）

`writes/noWrites` 看写意图（**硬证据**），`state/context/logs` 是辅证。除注明外，都只看「**上次 assert 之后新增**」的增量（游标语义见文末）。

| 字段 | 形态 | 语义 |
|---|---|---|
| `label` | 字符串 | 断言名（也可 `name`），失败排查时 human-readable |
| `writes` | `[{kind?,op?,nodeId?,desc?,args?}]` | **全序列等长 + 逐条部分匹配**：条数必须相等，每条只比"给出了的字段"，`args` 一旦给出必须**完全相等** |
| `noWrites` | `true` 或 `["op1","op2"]` | `true` = 本段不允许任何写意图；数组 = 不允许这些 op |
| `state` | `[{entityId, state?, attributes?}]` | 虚拟实体当前值。`state` 宽松比较（String 化后相等即过），`attributes` 深比较 |
| `context` | `[{scope?, key, value}]` | 虚拟上下文当前值，`value` 深比较；`scope` 缺省 global（**注意与 `inject_context` 相反**：断言缺省读 global，注入缺省写 local，源码 `runSteps` 的 `inject_context` 分支） |
| `logs` | `["子串"]` 或 `[{level?, message?}]` | 本段日志里**出现过**即通过；字符串 = 包含匹配，对象 = `level` 相等且 `message` 包含 |
| `expect` | 路径 DSL（下） | 任意路径断言。`writes/logs` 沿用增量基准，`entities/context/stats/timers/watchers/execution/tasks/clockNow/at/seq` 看**当前世界全量**；要看全量写/日志用 `allWrites/allLogs` |

#### expect 路径 DSL（无 eval，安全路径解析）

- 单条：`{ "path": "...", "<算子>": 值 }`；顶层直接给数组 = 全部满足（AND）。
- 组合器：`all` / `any` / `not`，可嵌套。
- 算子：`eq` / `ne` / `gt` / `gte` / `lt` / `lte` / `match`（正则）/ `includes` / `exists` / `type`。

```json
[
  { "path": "writes[0].op", "eq": "heatOn" },
  { "path": "writes.length", "gte": 2 },
  { "path": "logs[-1].message", "includes": "开水器开起啦" },
  { "path": "context.global[\"waterHeater.avoiding\"]", "eq": true },
  { "path": "entities[\"sensor.p\"].state", "type": "string" },
  { "any": [ { "path": "stats.sent", "gt": 0 }, { "path": "timers.length", "eq": 0 } ] }
]
```

path 常用位置：`writes[i].kind/op/nodeId/args/at`、`writes.length`、`logs[-1].message`（负数 = 倒数第 N 条）、`context.global["x.y"]`、`entities["sensor.p"].state`、`stats.sent`、`timers.length`、`execution.state`、`tasks["<scriptId>"]`。

#### 两条计数陷阱（必记）

1. 一次 `ctx.write(...)` 产生**两条**写意图：`kind:'service'` + `kind:'write'`。断言 `writes` 数量要 ×2，或者只按 `op` 部分匹配。
2. `ctx.global.set` / `ctx.local.set` 也会产生写意图：`kind:'context', op:'contextSet'`。断言序列里漏了它必失败。

#### 游标语义

`writes` / `logs` / `expect` 里的 `writes/logs` 默认只看「上次断言之后新增」，避免上一段证据重复计入（每个 assert 结束时游标推进到当前 seq）。要重看全量：单独调 `sim_assert` 时传 `since:0`；用例内的 assert 只能用增量（多个 assert 就是天然分段）。

#### 返回体怎么读

```json
{ "ok": true, "total": 3, "passed": 3, "failed": 0, "executed": 7, "aborted": false, "results": [...], "final": {...} }
```

- `ok` = 全部通过且未中断；`total/passed/failed` 只数 assert；`executed` 是实际执行的步骤数（中断时会小于 steps 长度）；`aborted=true` 表示中途抛异常/未知 op。
- 失败排查顺序：先看 `results[i].checks[]` 里 `pass:false` 的 `expected` vs `actual`（附中文 message），再对照 `final.writes` 的 `at`（虚拟毫秒）核对时间点。

### 4.3 归档 → 重放（把这次跑通变成回归资产）

用例只有一处：**`skill/.fixtures/<scriptId>/<name>.json`**——既是可复用资产，也是 `sim_export` 的落点、`sim_run_fixture` 的读取目录（`server/config.js` 的 `FIXTURES`，可用 `HA3D_AUTOMATION_FIXTURE_DIR` 覆盖）。用 `case.cjs` 管理，不要手抄路径：

```bash
node skill/tools/case.cjs list                               # 已有用例
node skill/tools/case.cjs save <id> <name>                   # sim_export 当前会话 → 直接写进 skill/.fixtures
node skill/tools/case.cjs run  <id>/<name>                   # 直接喂 sim_run_steps（默认重建世界）
node skill/tools/case.cjs push <id>/<name> --run-fixture      # 走服务端 sim_run_fixture 重放（不复制文件）
```

底层 MCP 等价：`automation_sim_export {"scriptId","name"}` → 落 `skill/.fixtures/<id>/<name>.json`；`automation_sim_run_fixture {"scriptId","name"}` → 读同一份并重建世界重放。

- fixture = **起始时刻 + 初始种子 + 驱动流水（全部 inject/advance）+ 观测到的写意图序列 + 脚本版号/sha**，不含中间断言。
- `sim_run_fixture` 默认在末尾追加一条「写意图全序列」断言；**用例自带 `assert` 时自动跳过**（那些断言已把游标消耗掉，追尾断言只会看到 0 条而误判），改由用例自身断言判定；要强制追加传 `assertWrites:true`，要关闭传 `false`。
- 手写用例要全序列校验，用 `case.cjs run`：它在 `run_steps` 之后追加一次 `sim_assert {since:0, writes: expected.writes}`。
- `fixture.versionDrift=true` → 脚本已改（版号或 sha 变），断言失败先怀疑版本漂移，而不是逻辑回归。手写用例记得填 `scriptVersion`，否则会误报漂移。
- 用例格式、收录门槛、索引表见 `skill/.fixtures/README.md`。

### 4.4 跨脚本联动在仿真里的口径（ctx.call / ctx.task.*）

仿真只覆盖本脚本，不联动其他脚本（硬规则）。涉及另一个脚本时，各接口的仿真实现与验证边界：

| 接口 | 仿真实现 | 能验证 / 验不了 |
|---|---|---|
| `ctx.call` | 仿真宿主直接回 **mock 回执** `{id, version:0, mode:'shadow', started:true, mocked:true}`——只证明"调用链路走到了" | ✅ 调用后的后续逻辑；❌ 被调脚本真的执行、其内部动作（那是它自己的仿真/影子的事） |
| `ctx.task.status` | 读虚拟任务表；**没注入过的脚本默认 `stopped`**，返回结构与真实模式一致（`version:0, mode:'production'`） | ✅ 依赖各状态分支的读侧反应 |
| `ctx.task.require` | **完全可验证**：轮询定时器走虚拟时钟（只有 `advance` 才走），靠反复 `taskStatus` 轮询推进 | ✅ `inject_task {state:'running'}` 验放行；不注入 + `advance` 推过 timeout 验超时抛错/降级（timeout 是虚拟时间） |
| `ctx.global.watch` | **注册回放读虚拟桶**：仿真宿主 `contextGet` 无值返回 undefined → 桶无值不回放，与真实口径一致；回放值与 `inject_context` 派发的事件共用同一回调（`info.source='replay'` 可区分）。**写者状态折叠可验**：`inject_context` 带 `writer` 盖章后，`inject_task` 改写者状态即派发 `contextWriterState`，防抖走虚拟时钟（`advance` 可推动）；seed 预置的 global 键**无写者**，要验写者失效必须先 `inject_context` 盖章（`sim_run_steps` 的 `inject_context` 同样支持 `writer` 字段；脚本注册早于盖章步骤时，首个带 `writerSid` 的值事件会补建写者缓存，down 防抖仍可验） | ✅ 基线裁决 + 值通知 + 写者失效/恢复全链路 |
| `ctx.local.watch` | **注册回放读虚拟 local 桶**：`inject_context scope=local`（缺省）会 dispatch `contextChange` 进回调（`info.source='set'`，回放为 `'replay'`）；脚本内 `ctx.local.set` 同样触发。仿真注入是 local 唯一外部写入源，不派发就验不到 | ✅ 私有持久化状态驱动重评、回放 vs 注入区分 |
| `ctx.ref` | 纯脚本进程内机制，与虚拟时钟无关，仿真下语义不变（同值静默、结构比较、`immediate` 回放） | ✅ 可直接验赋值通知行为 |
| `ctx.gate` | 纯脚本进程内机制，与虚拟时钟无关，仿真下语义不变（忙合并、只保留最后一次） | ✅ 可直接验合并行为 |

验证示例（依赖等待 + 超时降级）：

```json
[
  { "op": "advance", "ms": 30000 },
  { "op": "assert", "label": "require 30s 超时 → 降级分支", "logs": ["等待依赖脚本"] },
  { "op": "inject_task", "scriptId": "<依赖id>", "state": "running" },
  { "op": "assert", "label": "依赖就绪 → 正常分支", "writes": [{ "op": "<放行后的写>" }] }
]
```

要点：`inject_task` 写虚拟表并驱动写者折叠派发（`require` 靠轮询读虚拟表，无需直派）；`version:0` / `mode:'production'` 是仿真回执的固定值，断言别写死真实版本号。

---

## 5. 关键坑与排查

| 现象 | 原因 / 处理 |
|---|---|
| 时钟不动、定时器不触发 | 仿真时钟不会自己走，必须 `advance`；`ctx.after` 的毫秒数是**虚拟时间** |
| 导出 fixture 里没有 `advance`、重放 0 条写意图 | 历史 bug（已修）：runSteps 曾绕过 `advance()` 包装，tape 丢推进步骤。升级后重跑；断言 fixture 里 `steps` 应含 advance |
| 脚本碰 `Date.now()` / `new Date()` 抛 `reading 'startEpoch'` | 历史 bug（已修）：`VirtualClock.now` 交进沙箱丢 `this`。修复为箭头闭包；回归用例在 `tests/sim-e2e.test.mjs` |
| `脚本异常：[object Object]` | 已升级为 `message → error → JSON → String` + 前 3 行栈；看日志里真正的 error |
| 断言数量对不上 | 先数 `ctx.write` 次数 ×2 + `contextSet` 条数 |
| `toggle` 之后脚本没复核 | 历史 bug（已修）：`callService` 只回写 turn_on/turn_off/set_value，`toggle` 不翻状态也不派发 → `watch` 该实体的脚本收不到「状态变了」。现在 `toggle` 按 `on ⇄ off` 翻转并派发 `state`（回归用例在 `tests/sim-session.test.mjs`） |
| `entities` 快照缺实体 | 默认 `entityScope:'used'`（脚本读/写/注入过才算用），要全量传 `"all"` |
| 切模式报已在该模式 | 缺省幂等；要强制重建传 `force`（executor 层，MCP 未暴露则先切 follow 再切回） |
| 仿真会话突然消失 | worker 崩溃：现场以**只读快照**保留在 `data/runtime/<id>/v<n>.sim.crash.json`，`sim_snapshot` 会返回 `crashed/readOnly/fromCrashFile`；重进仿真时清除 |
| `sim_close` 报拒绝 | 当前影子是 `follow`，改用 `automation_stop_script` |
| 结论不可信 | 检查 `versionDrift`、检查是否用了真实时间等待（仿真里真实 `setTimeout` 不会被虚拟时钟推动） |

---

## 6. 收尾：切回 follow 并让影子继续跑（固定动作，不是可选清理）

仿真只是临时状态。跑完必须回到有真实数据的影子模式，并且**让同一个影子版本保持运行**，否则 5.3 的真实验收没有发生：

```bash
node skill/tools/case.cjs finish <scriptId>
```

一条命令完成四件事：`switch_verify_mode {"mode":"follow"}`（内部停仿真实例 → 等真正退出 → 以 follow 重启同一影子版本）→ 查 `runningVersions` → 没跑起来就显式补 `start`（**点名影子版本号**，不传 version 会取最高版本、可能误启正式）→ 打印 `status / verifyMode / host / 最近 5 条日志`。

收尾验收清单：

- [ ] `runningVersions` 里存在 `mode:"shadow"` 且 `verifyMode:"follow"` 的实例，`status=running`；
- [ ] 日志开头有 `runner 启动 vN｜模式=影子` 与基线拉取，无 error（切换时的 `[模式切换] simulate → follow` 是 warn，正常）；
- [ ] 此后的写只记 `[影子·拦截写操作]`，没有 `[真实写操作]`；
- [ ] `v<n>.sim.log` 停止增长——之后判断结论要看真实日志，别再看仿真日志。

**不要用 `sim_close` 收尾**：它只销毁虚拟世界并停实例，不会回 follow，验证链会断在这。`sim_close` 只用于「这批用例不打算继续验了，先收摊」。

其他收尾项：

- 回归资产：`node skill/tools/case.cjs save <id> <name>` 直接写进 `skill/.fixtures/<id>/`（与可复用用例同一份），下次改脚本先 `case.cjs run` 跑一遍。
- 面板可见：列表/版本条/详情头的「仿真中 / 仿真验证」虚线徽章 + 「⇄ 进入仿真 / 切回影子模式」按钮；仿真日志独立写 `data/runtime/<id>/v<n>.sim.log`（`GET /api/script/:id/logs?source=sim`），时间列显示虚拟时刻 `+3.0s`。
- 汇报写清：起点时刻与种子、断言条数与通过数、写意图时间点（`at` 是虚拟毫秒）、终态上下文、归档的用例名，以及**已切回 follow、影子 vN 正在运行**。
