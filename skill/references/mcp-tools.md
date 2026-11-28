# MCP 工具清单

共 37 个工具（16 只读 + 19 受控写（8 脚本/版本 + 11 仿真）+ 2 面板控制），SSE 端点 `http://localhost:8100/mcp/sse`。
所有工具经 `wrapToolActivity` 统一广播活动到前端横条。

**受控写**全部要求 `confirmed: true` 显式确认；`automation_call_service` 还需服务端开启 `allowMcpCallService`（默认关闭）。

仿真（`simulate`）的用法、断言 DSL、踩坑清单见 `simulation.md`，这里只列接口参数。

命令行快速调用：

```bash
node skill/tools/mcp-call.cjs <tool> ['{json 参数}']
# 例：
node skill/tools/mcp-call.cjs automation_list_scripts
node skill/tools/mcp-call.cjs automation_get_logs '{"scriptId":"s2countd"}'
```

---

## 只读（16 个）

### 系统与版本

| 工具 | 参数 | 说明 |
|---|---|---|
| `automation_get_system_info` | 无 | **线上版本与运行态快照**（纯只读、不需确认）。`version` 取自服务端 `package.json`，与镜像 tag 同源——**读源码前先调它和本地仓库 `package.json` 版本比对**：一致才采信 clone 的源码，不一致先切到对应 tag。另含 `devMode`（true=HA 写只记日志不下发）、`haStatus`、`demo`、`executionMode`、`scripts`/`running` 实例数、`node`/`platform`/`uptimeSeconds`、`ts`。不返回 token 等敏感配置 |

### 实体与状态

| 工具 | 参数 | 说明 |
|---|---|---|
| `automation_list_entities` | `filter?`（关键字，按 entity_id / friendly_name 过滤） | 列出 HA 实体（只读快照，不含 token），最多返回 200 条 |
| `automation_get_state` | `entityId` | 单实体当前状态与属性；实体不存在报错 |
| `automation_list_services` | 无 | 列出 HA 可用域与服务（生成脚本时确认服务名） |
| `automation_get_history` | `entityId`、`hours?`（1~720，默认 24） | 实体历史，返回 `{eid:[{s,t}]}` |

### 脚本仓库

| 工具 | 参数 | 说明 |
|---|---|---|
| `automation_list_scripts` | 无 | 脚本清单（latest/shadow/production/runningVersion、status 运行状态、shadowRevision） |
| `automation_get_script_status` | `scriptId`、`version?`、`logLimit?`（1~1000） | 指定版本的元数据、flow、运行态（status 版本级 + scriptStatus 脚本级）与最近日志 |
| `automation_get_logs` | `scriptId`、`version?`、`mode?`（`shadow`=当前影子 / `production`=当前正式，version 优先）、`limit?`（默认 200） | 结构化运行日志（JSON 行）。影子与正式日志按版本分文件，返回体带 `version` 与 `channel`（该版本所属通道） |
| `automation_list_versions` | `scriptId` | 所有版本及角色（shadow/production/archive）、revision、archivedKind、updatedAt（提交/发布时间）、status 运行状态；影子与正式各至多 1 个 |
| `automation_get_context` | `shadow?`（true=影子命名空间，默认正式） | 只读查询 ctx.global / ctx.local 存储 |
| `automation_guard_status` | 无 | **兜底健康检查**：HA 连接/就绪态 + 每个运行脚本引用的实体 + 是否因实体被删暂停（排查暂停原因） |

### HA 自动规划迁移（只读）

| 工具 | 参数 | 说明 |
|---|---|---|
| `automation_list_ha_automations` | 无 | HA 原生自动化清单（entity_id / 名称 / 启用态 / mode / 最近触发） |
| `automation_get_ha_automation_config` | `entityId`（automation.xxx） | 单条自动化完整配置（triggers / conditions / actions / mode） |
| `automation_list_ha_scripts` | 无 | HA 原生脚本（script.*）清单 |
| `automation_get_ha_script_config` | `entityId`（script.xxx） | 单条原生脚本 sequence 配置 |
| `automation_resolve_entities` | `ids[]`（device_id 或 entity_id） | 把 device_id / 十六进制内部 id 解析为真实 entity_id（Flode 自动化常见 device 目标） |

---

## 受控写（19 个，均需 `confirmed: true`）

### 脚本与版本（8 个）

| 工具 | 参数 | 说明 |
|---|---|---|
| `automation_submit_script` | `script`（源码，AST 校验）、`flow`、`confirmed:true`、`scriptId?`（新建可不传，服务端生成）、`name?`（**新建必须传贴切中文业务名，严禁用 id 充当名字**；迭代可省略，自动继承上一版）、`icon?`（**新脚本首次提交必须提供**：完整 `<svg>` 源码字符串 ≤8KB，viewBox 0 0 64 64、`stroke="currentColor"`；后续迭代自动继承，规范见 `references/file-specs.md` §icon）、`description?`、`kind?`（automation=常驻（默认）/ script=一次性动作 / scene=场景；运行模型由此派生）、`channel?`（默认 shadow，一般不要直接建 production）、`newVersion?`（强制另开版本号）、`hostMode?`（脚本级宿主覆盖：fork/inprocess/worker 三值对称，跟随版本持久化、迭代自动继承；未设置走默认策略——正式一次性走热池会话、常驻跟随全局 EXECUTION_MODE。影子恒为专属 worker 不受影响）、`runnerTimeoutMs?`（脚本级运行超时覆盖，一次性脚本含长延时时用）、`restartable?`（可重入触发：重复 trigger/ctx.call 时停旧启新） | 提交脚本。**影子可原地反复修改**：已有影子时默认覆盖（版本号不变、revision+1，返回 `overwritten:true`）；改运行中的影子会先自动停止。正式/归档内容不可改 |
| `automation_start_script` | `scriptId`、`version?`、`confirmed:true` | 启动指定版本；槽位规则：同一脚本最多 1 正式 + 1 影子并行，同槽位已占用报错 |
| `automation_stop_script` | `scriptId`、`version?`、`confirmed:true` | 停止实例；version 省略 = 停全部（正式+影子），给 version 只停该版本 |
| `automation_trigger_script` | `scriptId`、`channel?`（production=正式，默认，真实下发 / shadow=影子，写不下发，验证用）、`confirmed:true` | **按次触发一次性脚本/场景**（kind=script/scene）：起独立实例跑顶层代码，跑完自动清理。只返回启动回执——不等跑完、无返回值，结果用 `automation_get_logs` / `automation_get_script_status` 确认。常驻自动化不能按次触发（用 start）；运行中未设 restartable 会报 busy |
| `automation_publish_script` | `scriptId`、`version?`（省略取当前影子版）、`autoSwitch?`（默认 true）、`confirmed:true` | 影子 → 正式（同版本号）：旧正式版自动归档，新正式版**真实下发**。若运行的是另一版本，自动切换实例（停旧→影子启动新→热切正式；起不来回退旧版），返回 `switchedFrom`；`autoSwitch:false` 则严格报错 |
| `automation_rollback` | `scriptId`、`fromVersion`（历史版本号）、`confirmed:true` | 回滚：读历史版本（正式/归档）原文 → 提交为**新影子版本**（版本号继续递增，description 标"回滚自 vN"）。**不自动上线**，仍要走影子验证 → publish |
| `automation_delete_version` | `scriptId`、`version`、`confirmed:true` | 只能删**归档版本**；正式版不可删（先发布新版本使其归档）、影子是工作副本不可删（直接覆盖修改）、运行中需先 stop |
| `automation_call_service` | `domain`、`service`、`data?`、`confirmed:true` | 直接调 HA 服务。**默认关闭**（`allowMcpCallService=false`），且经动作互斥锁（同 entity+service+entityId 冲突报错） |

### 仿真 / 验证方式（11 个，均需 `confirmed: true`）

影子通道固定。验证是**两段固定顺序**：`simulate`（虚拟世界，验流程/时序/写意图）→ `switch_verify_mode {"mode":"follow"}` 切回影子模式并保持运行（验收门禁，`case.cjs finish` 一步完成）。仿真只覆盖本脚本，写只产生写意图；停在 simulate 不算验证通过。详见 `simulation.md`。

| 工具 | 参数 | 说明 |
|---|---|---|
| `automation_switch_verify_mode` | `scriptId`、`mode`（`follow`/`simulate`）、`startAt?`（ISO）、`seed?`（`{entities:{eid:{state,attributes}}, context:{global,local}}`） | 唯一切换入口：暂停旧实例 → 等真正退出 → 以目标模式启动（不热切，正式实例不受影响）。已是目标模式则幂等返回 |
| `automation_sim_inject` | `scriptId`、`payload.{entity\|context\|task\|suspend\|params}` | 注入一次变化：`entity`（先改虚拟表再触发订阅）/ `context`（`{scope,key,value}`）/ `task`（`{scriptId,state}`）/ `suspend` / `params`（覆盖触发参数，运行中注入仅进快照可见并记 warn，**下一次进入 simulate 才生效**） |
| `automation_sim_advance` | `scriptId`、`ms` | 快进虚拟时钟（毫秒），到点定时器按 dueAt 顺序触发；真实等待不会推进仿真 |
| `automation_sim_run_steps` | `scriptId`、`steps[]`、`startAt?`、`seed?`、`continue?`、`failFast?` | 批量跑用例 + 逐步断言，返回 `ok/passed/failed/total/executed/aborted`、每条 `checks` 与终态。**默认每次重建世界**；`continue:true` 才续跑且与 `startAt/seed` 互斥。`failFast` 缺省收集全部失败 |
| `automation_sim_assert` | `scriptId`、`writes?`、`noWrites?`、`state?`、`context?`、`logs?`、`expect?`、`label?`、`since?` | 对当前会话单次断言，不推进不重建。默认基准 = 上次断言以来的新增 |
| `automation_sim_snapshot` | `scriptId`、`since?`、`include?`（logs/writes/entities/context/stats/execution/timers/watchers）、`entityScope?`（`used` 缺省 / `all`） | 同步快照；`writes` 是硬证据。崩溃后返回 `crashed/readOnly/fromCrashFile`（读 `v<n>.sim.crash.json`） |
| `automation_sim_mark` | `scriptId`、`name?` | 标记世界数据点（实体/上下文/task），供 `sim_rewind` |
| `automation_sim_rewind` | `scriptId`、`mark` | 回滚**数据**到标记点；虚拟时钟继续前进、脚本定时器/订阅不回退（完全重放请重建世界或跑 fixture） |
| `automation_sim_export` | `scriptId`、`name` | 导出回归用例 `skill/.fixtures/<id>/<name>.json`（与可复用用例同目录）：startAt + seed + 驱动流水（inject/advance）+ 观测写意图 + 脚本版号/sha |
| `automation_sim_run_fixture` | `scriptId`、`name?`、`assertWrites?`（缺省 true）、`failFast?` | 重放同一目录里的用例并默认追加一条 `since:0` 写意图全序列断言（与用例自带 assert 并存、各验各的）；**仅当用例 `expected.writes` 为空且自带 assert 时不追加**（此时传 `assertWrites:true` 也无法强制追加，需要全序列校验改用 `case.cjs run`），`assertWrites:false` 显式关闭。`versionDrift=true` 说明脚本已改，先怀疑版本漂移。不传 `name` 只列已有用例 |
| `automation_sim_close` | `scriptId` | 结束仿真实例、销毁虚拟世界（不持久化）；`follow` 模式下拒绝（用 `automation_stop_script`）。**非收尾命令**：不会回 follow，收尾用 `case.cjs finish` / `switch_verify_mode {"mode":"follow"}` |

`steps[]` 的 `op`：`advance` / `inject_entity` / `inject_context` / `inject_task` / `inject_params` / `inject_suspend` / `mark` / `rewind` / `snapshot` / `assert`。

HTTP 等价：`POST /api/script/:id/verify-mode`（body `{mode,startAt,seed}`）、`GET /api/script/:id/logs?source=sim`（读 `v<n>.sim.log`）。

### 面板控制（无 confirmed）

| 工具 | 参数 | 说明 |
|---|---|---|
| `automation_select_script` | `scriptId`、`version?` | 切换前端面板选中项：左侧列表选中并打开该脚本详情（可指定版本）。提交/启停/发布后调用，把用户视线带到目标脚本。**提交与回滚本身会自动让前端重拉该脚本内容**（`refresh what:'script'`），本工具用于显式切换 |
| `automation_refresh_panel` | `what?`（scripts/script/versions/logs/all，默认 all） | 让前端重新拉取最新数据并刷新展示：scripts=左侧列表；script=当前打开脚本正文/流程图；versions=版本条；logs=日志；all=全部。只广播不写数据，无需 confirmed |

---

## 版本概念对照（汇报与排障时必须分清）

| 字段 | 含义 |
|---|---|
| `latestVersion` | 最新提交（可能是尚未上线的影子候选） |
| `shadowVersion` / `shadowRevision` | 当前影子版本号 / 它被原地改过几次 |
| `productionVersion` | 线上正式版本（真实下发的"唯一裁决者"） |
| `runningVersion` / `runningVersions` | 实例真正在跑的版本（主实例）/ 全部实例 [{version, mode, verifyMode}]：正式与影子可并行各一个，影子的 `verifyMode` 为 `follow` 或 `simulate` |
| `archivedKind` | 归档分级：`published`（曾上线，回滚候选）/ `discarded`（试错废弃） |

---

## 典型调用序列（脚本灰度上线）

```
list_entities → list_services        # 确认实体与服务名
submit_script (shadow)               # 首次提交 → 分配版本号
（迭代）submit_script                 # 修改 → 原地覆盖同一版本号，revision+1
start_script → get_logs              # 影子验证（写操作只记 [影子·拦截写操作]）
publish_script                       # 用户确认后发布正式；运行中实例自动切换
get_logs                             # 正式验证（[真实写操作] 符合预期）
guard_status                         # 核对引用实体与运行健康
（线上异常）rollback → start → get_logs → publish   # 回滚也是影子验证后发布
```

## 典型调用序列（影子仿真验证 + 回归）

```
submit_script (channel:shadow, newVersion? 仅当正式版也要验)   # 确保有影子版本
switch_verify_mode simulate + startAt/seed                     # 进虚拟世界
sim_snapshot (include:writes)                                  # 看启动瞬间
sim_run_steps (steps: advance/inject_*/assert)                 # 批量用例 + 断言，默认重建
sim_export → sim_run_fixture                                   # 导出回归资产并重放校验
# 资产化：把用例存到 skill/.fixtures，执行走 case.cjs（见 .fixtures/README.md）
#   node skill/tools/case.cjs save <id> <name> / run <id>/<name> / push <id>/<name> --run-fixture
switch_verify_mode follow   →  case.cjs finish <id>             # 固定收尾：停仿真 + 以 follow 重启同一影子并校验在跑
start_script (影子版本号) / trigger_script (channel:shadow)      # 5.3 真跑，保持运行、真实触发观察
publish_script                                                  # 仿真 + follow 都通过、用户确认后才发布
```

> `sim_close` 不是收尾命令：只销毁虚拟世界并停实例，不会回 follow。正常收尾只走 `switch_verify_mode {"mode":"follow"}`（或 `case.cjs finish`）。
