# ha3d-automation 项目优化审视报告

生成时间：2026-11-28　范围：`server/`、`client/src/`、`skill/`（含文档与工具脚本）、`scripts/`、Dockerfile / package.json 配置。
方法：按模块分 5 路只读扫描 + 交叉引用核对 + 对高危项逐一实读源码/编译验证复现。**本次只出报告，未改任何代码。**

## 摘要

| 类别 | 确认问题 | 其中高严重度 |
|---|---|---|
| 1. 死代码 | 6 | 0 |
| 2. 逻辑碎片/过度拆分 | 8 | 0 |
| 3. 架构/功能过度耦合 | 7 | 2 |
| 4. bug | 13 | 4 |
| 5. 注释描述不符 | 9 | 0 |
| 6. 文档描述不符/引用错误 | 13 | 3 |

> **全部 6 类 56 项已于 2026-11-29 闭环处理完毕**（各类详情见下文 ✅ 块）。

**排除的误报（已实测验证，不是问题）**：`.dockerignore` 的 `*.md` 不会掏空 skill.zip（Docker 的 `*` 不跨 `/`，实测 zip 含 SKILL.md + 4 个 references）；`TopologyPanel.vue` 的 `mode` 编译产物是 `$setup.mode.value`（正确，子代理推演的 `mode.value.value` 不成立）；当前工具数 37 与 tools.js 文件头、mcp-tools.md 一致。

**优先处理顺序**：P0 高危 bug（demo 竞态、虚拟时钟清理、mode 通道串味等）→ P1 文档断链与数字错误（直接影响 Agent 按文档操作）→ P2 死代码与结构重构。

---

## 1. 死代码（✅ 已全部删除，2026-11-28）

处理结果：1.1 删除 `writeSimCrash` 函数与导出（留注释指明实际写入在 worker 侧）；1.2 返回对象改为 `{ handleMessage, destroy, simState }` 并留注释；1.3 删除 `entryKey` 别名（内部直接用 `instKey`）并从导出移除；1.4 删除两个死 CSS 类；1.5 删除 `POLL_DEFAULT` 死 fallback；1.6 删除 `settleSync` 的 `return sim`。验证：全库无残留引用，`npm test` 298/298 通过，`start:dev` 重启后 9 个实例按运行意图成功自动恢复（实测 run-state 重构未破坏恢复链）。

| # | 位置 | 问题 | 严重度 |
|---|---|---|---|
| 1.1 | `server/scripts/store.js:465-474,668` | `writeSimCrash` 定义并导出但全项目零调用；`worker-runner.js:53-66` 另写一份 `writeCrashSnapshot`，同逻辑两份实现，改格式易漏一处 | 中 |
| 1.2 | `server/scripts/runner-core.js:1110` | 返回对象的 `isStopped`、`ctxRuntime` 无任何消费者（4 个宿主只用 handleMessage/destroy/simState）；`ctxRuntime` 还是内部可变状态的封装泄漏点 | 中 |
| 1.3 | `server/scripts/run-state.js:29,91` | `entryKey` 只是 `instKey` 的别名，外部零引用 | 低 |
| 1.4 | `client/src/style.css:326-327` | `.vb-status.running/.paused` 永不命中：唯一使用处 `App.vue:441` 在 `!runningOf(v)` 时才渲染，而 `versionStatus` 在该路径已把 running/paused 改写成 stopped | 低 |
| 1.5 | `client/src/lib/live-tip.js:13,124` | `POLL_DEFAULT=3000` 的 fallback 死掉：进入分支前提已是 `pollMs>0`，`pollMs || POLL_DEFAULT` 恒等于 pollMs | 低 |
| 1.6 | `client/src/lib/topo.js:97` | `settleSync` 返回 `sim` 无人消费（两处调用都忽略返回值） | 低 |

## 2. 逻辑碎片和过度拆分（✅ 已全部修复，2026-11-28）

处理结果：2.1 新增 `executor.statusSummary(sid, version)` 聚合，REST 详情与 MCP get_script_status 各一行展开替代 5 个函数拼装（对外字段与返回结构不变）；2.2 新建 `server/lib/system-info.js` 的 `systemSnapshot()`，REST health（保留历史字段名 `ha`）与 MCP system_info 共用；2.3 `PKG_VERSION` 收敛到 system-info.js 唯一定义（sse.js/tools.js 都从它取）；2.4/2.5 store 新增 `currentInstance` getter，`currentVerifyMode` 与 App.vue 都从它派生（App.vue 删除重复实现）；2.6 三处 REST/MCP 裸 `hub.broadcast` + executor 内部 3 处自查点全部统一走 `broadcastRefresh(['scripts'])`（广播自动带 ts）；2.7 `topologyForGlobalDisplay` 复用 `scriptNamesMap()`，去掉内联 Map 与 fromEntries 转换；2.8 删除 `notifyCtxWriterObservers` 中间层，dryRun 过滤并入 `notifyCtxWriterState(sid, reason, changedEntry)` 签名（6 个调用点行为等价）。验证：298/298 测试通过，前端 build 通过，重启后 REST/MCP 状态字段、health、运行实例恢复全部实测正常。

| # | 位置 | 问题 | 严重度 |
|---|---|---|---|
| 2.1 | `server/scripts/executor.js:249-326` | 同一份 running/entityPaused 状态被 `isRunning`/`runningVersion`/`runningVersions`/`versionRuntimeStatus`/`scriptRuntimeStatus`/`taskStateFor` 6 个函数按不同口径投影；调用方（routes/scripts.js:145、mcp/tools.js:114）要并行调 4 个才拼出完整状态 | 中 |
| 2.2 | `server/mcp/tools.js:28-41` vs `server/routes/system.js:13` | 同一份系统运行态快照（status/demo/devMode/scripts/running）在 MCP 工具与 HTTP health 各拼一遍，`haStatus`/`ha` 字段命名还不同 | 中 |
| 2.3 | `server/mcp/sse.js:9` 与 `server/mcp/tools.js:16` | `PKG_VERSION` 常量重复定义两处，两处 require 同一 package.json——正是注释想避免的漂移本身 | 低 |
| 2.4 | `client/src/stores/scripts.js:29-33` vs `App.vue:88-93` | `verifyMode` 派生（当前版本→实例→verifyMode）逐字重复两份；改一处漏一处会导致"徽标显示仿真、日志读真实" | 中 |
| 2.5 | `client/src/App.vue:130,88` 与 `stores/scripts.js:190-193` | "当前版本是否有实例"的同一查找写三份 | 低 |
| 2.6 | `server/mcp/tools.js:413` vs `:307`、`routes/scripts.js:199,219` | 注释称刷新广播统一走 `broadcastRefresh`，但三处直接 `hub.broadcast` 裸写，缺 ts/extra，前端行为不一致 | 低 |
| 2.7 | `server/routes/scripts.js:23-25,43,64` | `scriptNamesMap()` 定义了一处，`topologyForGlobalDisplay` 又内联两遍同样的 Map/对象转换 | 低 |
| 2.8 | `server/scripts/executor.js:330-333,366-371` | `settleStatus → notifyCtxWriterObservers → notifyCtxWriterState` 三层层层转发，中间层仅为过滤 dryRun 的一行 | 低 |

## 3. 架构或功能过度耦合

> **✅ 已全部修复（2026-11-29 本轮）**：3.1 sim 控制面抽出为 `server/scripts/sim-control.js`（executor 1444→1206 行，回执表/switchVerifyMode/sim* 12 函数迁出，deps 注入边界）；3.2 App.vue 481→419 行，toast/confirm 抽为 `composables/useToast.js`·`useConfirm.js`，日志面板抽为 `components/LogPanel.vue`；3.3 详情组装收敛到 `server/lib/script-detail.js`，REST 与 MCP get_script_status 共用（REST 增量获得 channel 字段，其余不变）；3.4 `PUT /api/config` 只在 haUrl/token 真正变化时 connector.restart()，响应新增 `haRestarted` 字段；3.5 hold 状态机抽出为 `server/scripts/hold.js`（runner-core 1115→925 行，闭包依赖全部显式 deps 注入）；3.6 sim.log 读写契约集中到 `server/scripts/sim-log.js`，store 与 worker 共用；3.7 inline-runner 全局守卫改用 `Symbol.for` 自有标记幂等，不再看 listenerCount。验证：npm test 298/298、前端 build 通过、start:dev 重启后端到端（切仿真→advance→快照→切回→sim.log 格式统一→REST/MCP 详情字段一致→空 patch 不重连）全部通过。

| # | 位置 | 问题 | 严重度 |
|---|---|---|---|
| 3.1 | `server/scripts/executor.js`（1437 行） | 单模块承担 8+ 职责：实例生命周期/动作锁/看门狗/日志/拓扑适配/HA 门控/ctx.watch 分发/发布切换/sim 控制面 12 函数/重启恢复。发布与模式切换的热切路径是竞态高发区，sim 控制面可独立成模块 | **高** |
| 3.2 | `client/src/App.vue`（484 行，script ~290 行） | 上帝组件：toast/确认弹窗/HA·WS 状态/脚本列表/版本条/发布回滚/验证切换/日志滚动/拓扑切换全挤在一起；第 4 类多数 bug 聚集于此 | **高** |
| 3.3 | `server/mcp/tools.js:9-11` | MCP 工具层直接穿透 `store`/`context`/`validate` 内部细节，既依赖 executor 又依赖 store；与 REST 路由形成"同一领域两套数据组装" | 中 |
| 3.4 | `server/config.js:94` | `resetConfigCache()` 一处清空全局 cached，隐式改变 connector/haUrl/token/allowMcpCallService/devMode 多个模块行为，并触发重连→脚本挂起/恢复的隐式链路 | 中 |
| 3.5 | `server/scripts/runner-core.js:47-1113` | 单个 `createCore` 闭包内嵌全部 ctx API，其中 `hold` 独占近 190 行状态机，几乎可独立成模块 | 中 |
| 3.6 | `store.js:596-606` vs `worker-runner.js:30-48` | sim.log 主进程与 worker 两套写入实现，靠"主进程清空 + worker 用 a 追加"的隐式约定协同（本轮刚修过，仍是耦合点） | 中 |
| 3.7 | `server/scripts/inline-runner.js:18-29` | inprocess 模式在主进程挂 `unhandledRejection`/`uncaughtException` 全局监听，用 `listenerCount===0` 判断会与其他模块的全局 handler 相互干扰 | 中·待确认 |

## 4. bug

> **✅ 已处理（2026-11-29 本轮，12 修复 + 1 排除）**：
> - **4.1 已修**：`_startDemo` 改为先填实体/服务再置 ready/onReady，demo 模式不再误暂停全部脚本。
> - **4.2 已修**：`cleanupLocal` 改用 `clk.clearTimeout/clk.clearInterval`，虚拟时钟定时器 stop 时能真正清掉。
> - **4.3 已修**：编译实测确认属实（模板产物 `$setup.mode.value`，而 `$setup` 经 proxyRefs 解包，`.value` 得 undefined）——4 处 `mode.value` 改为 `mode`，影子脚本列表 hover 不再查错命名空间。
> - **4.4 已修**：`stop()` 补 `.then(unwrap)`，服务端 `{error}` 不再被静默吞掉。
> - **4.5 已修**：config.js 导出 `ENV_OVERRIDES` 映射，`PUT /api/config` 响应新增 `overridden` 列表，ConfigModal 保存后明确提示哪些字段被环境变量覆盖未生效。
> - **4.6 已修**：`readFileConfig` 区分 ENOENT 与解析失败，损坏文件写 console.error 留痕，不再静默用空对象写回。
> - **4.7 已修**：`_fallbackSnapshot` 改为先订 subscribe_events 并等确认、再拉 get_states，串行化消除"晚到全量覆盖增量"竞态。
> - **4.8 已修**：sse.js 的 connected 广播与 sessions 注册移到 connect 成功之后；close 清理幂等化（只广播一次 disconnected）。
> - **4.9 排除（设计使然）**：复核 `switchVerifyMode` 全部失败路径——cur 存在时启动失败必补发 running（回滚成功）或 error（回滚也失败）广播，"永久卡切换中"不可达；防闪动空窗是刻意设计且有测试锁定（client-store.test.mjs）。代码不改，已在 store 注释留分析依据。
> - **4.10 已修**：open/loadVersions 快照回填加竞态防护——在途时 WS setStatus 增量进缓冲，快照落地后按序回放（深度计数支持嵌套）。
> - **4.11 已修**：simulate 实例不再 `runState.mark` 持久化运行意图（虚拟世界不持久化，重启不得按 follow 悄悄真跑）；新增回归测试断言。
> - **4.12 已修**：simWrite 防御分支补 `at`（缺省 0），与脚本日志 +X.Xs 口径一致。
> - **4.13 已修**：`useLiveTip` 借 `getCurrentScope/onScopeDispose` 注册组件卸载清理，切视图不再残留轮询定时器。
>
> 验证：npm test **300/300**（含新增 audit4-regression）；前端 build 通过；重启后实测——空 patch/改参数 PUT config 返回 `overridden:[]` 且不重连，MCP SSE 建连正常，临时脚本切仿真后 desired-running.json 不含该脚本（4.11 线上复验），9 实例正常恢复。

| # | 位置 | 问题 | 严重度 |
|---|---|---|---|
| 4.1 | `server/ha/connector.js:88-104` | **demo 模式下 `onReady()` 早于实体填充**：`_startDemo()` 先置 ready=true 并调 `onReady()`，此时 entities 为空；`onHaReady()`（executor.js:188-201）用 entityStatus 复核依赖，demo=true 使 isReady 返回 true、空表判定 `missing`，于是**把所有运行脚本按"实体缺失"暂停**。随后填充实体不触发 onStateChange，只有 sensor.temperature 在 10s 后恢复，其余永久停在暂停态。触发路径：PUT /api/config → connector.restart() | **高** |
| 4.2 | `server/scripts/runner-core.js:1077-1080` | **虚拟时钟定时器清理用错 API**：`cleanupLocal` 用全局 `clearTimeout/clearInterval` 清 sim 定时器，而 `VirtualClock.setTimeout` 返回自增数字（`clock.js:50`），全局 clear 清不掉。同函数 1073 行对 writerDebounce 正确用了 `clk.clearTimeout`。stop 时虚拟定时器在宽限期内存活（受 stopped 闸限制，影响有限） | 中 |
| 4.3 | `client/src/components/TopologyPanel.vue:159,167,175,186` | 列表 hover 传 `mode: mode.value`，但 `mode` 是 computed，在 `<script setup>` 模板中自动解包——此处 `mode.value` 实际取的是解包后字符串的 `.value`，得到 `undefined`，最终 fallback 到 production。影子通道脚本的列表 hover 取值会查错命名空间；图形视图（走 props）不受影响。编译实测确认 | **高** |
| 4.4 | `client/src/stores/scripts.js:149-155` | `stop()` 是唯一不走 `.then(unwrap)` 的写操作（start/trigger/publish 都走了），`unwrap` 注释声称"所有 POST/DELETE 统一转异常"——服务端返回 `{error}` 时 stop 静默失败，还会继续 syncStatus | 中 |
| 4.5 | `server/config.js:80-96,55-68` | `WRITABLE_KEYS` 含 executionMode/haUrl/token/runnerTimeoutMs 等，但这些字段被 env 优先覆盖；用户 PUT /api/config 保存后返回 200 且回显旧值，改动既不生效也无提示 | 中 |
| 4.6 | `server/config.js:35-41` | `readFileConfig()` 吞掉所有异常返回 `{}`；若 config.json 只是格式损坏，`saveConfig()` 会用空对象写回，token/HA 地址丢失且无日志 | 中 |
| 4.7 | `server/ha/connector.js:248-264` | 回退快照的 `get_states`（全量）与 `subscribe_events`（增量）并发发出、无先后等待；增量先到会被随后到达的旧全量快照覆盖（与 181-182 行注释声称的"绝不并发"相反） | 中 |
| 4.8 | `server/mcp/sse.js:30-35` | SSE 初始化失败分支删除 session 但不广播 `disconnected`（正常关闭路径有），前端横条会一直显示 MCP 已连接；且 `res.on('close')` 随后仍触发，重复清理 | 中 |
| 4.9 | `client/src/stores/scripts.js:217` | `setStatus` 对 `stopped` 且 current.status=switching 直接 return，同时跳过 runningVersions 移除/syncStatus 等后续所有更新；切换失败或启动失败只发 stopped 时，按钮永久卡在"切换中…" | 中·待确认 |
| 4.10 | `client/src/stores/scripts.js:49,65,220-227` | 异步 `open/loadVersions` 整表覆盖 `runningVersions`，而 WS `setStatus` 增量维护同一数组；启动/停止瞬间的回包晚到会覆盖刚写入的实例，徽标与按钮短暂错乱 | 中·待确认 |
| 4.11 | `server/scripts/executor.js:528,1056` | simulate 实例也执行 `runState.mark` 持久化运行意图；进程重启后 `restore()` 不传 opts、默认 follow 模式拉起→仿真变影子真跑（写仍被闸拦）。与 onExit（1077-1078）"simulate 不自动重启"的设计意图矛盾 | 中·待确认 |
| 4.12 | `server/scripts/executor.js:559-560` | `simWrite` 防御分支广播带 `sim:true` 但缺 `at`，前端按墙钟渲染，与脚本日志的 +X.Xs 混排——正是上一轮刚修过的同类问题，这条漏网（注释称正常路径不可达） | 低 |
| 4.13 | `client/src/lib/live-tip.js:121-125` | 轮询定时器只在 open/hide 清除，TopologyGraph/GlobalTopology 卸载时（v-if 切视图）未调 hide，鼠标停留时定时器继续请求并写已卸载组件 | 低 |

## 5. 注释描述不符

> **✅ 已全部处理（2026-11-29 本轮，6 处改文本 + 3 处随前几轮修复自然解决）**：
> - **5.1 已修**：executor.js 文件头与执行方式注释改为"影子强制专属 worker"（与 2026-11-26 热池改造一致，三处口径统一）。
> - **5.2 已随 4.7 修复解决**：connector.js "二者绝不并发"注释在 _fallbackSnapshot 串行化后已与代码一致。
> - **5.3 已修**：runner-core.js ctx.watch 注释与 topology.js 两处去掉已删除的 `task.watch` 引用。
> - **5.4 已随 3.6 重构解决**：sim.log 口径三处注释经 sim-log.js 契约统一后已一致。
> - **5.5 已修**：runtime.js 头注释改为"各域路由 require 直接取用（零参），MCP 挂载只传一次 mcpCtx"。
> - **5.6 已修**：submit 工具 name 描述改为与实际行为一致（新建必须传；迭代可省略自动继承；不传且无上一版回退成 sid）。
> - **5.7 已修**：App.vue 角色判定注释补清"发布按钮比对 shadowVersion 是限定最新影子版本入口，与角色判定是两回事"。
> - **5.8 已随 4.4 修复解决**：stop() 已补 `.then(unwrap)`，unwrap 注释恢复准确。
> - **5.9 已修**：开发模式横幅文案改为"脚本的 HA 写都只记日志不下发（读正常）"，与注释"只拦脚本发起的 HA 写"口径一致。
> - **附带**：6 处代码注释引用不存在的 `SIMULATION-DESIGN.md`（tools.js/sim-control.js/worker-runner.js/clock.js/host.js/session.js）一并清理。

| # | 位置 | 问题 | 严重度 |
|---|---|---|---|
| 5.1 | `server/scripts/executor.js:2-6,390-399` vs `:397-446` | 文件头与段注释称"影子强制 fork"，实际 11-26 热池改造后是"强制专属 worker"，同文件三处互相矛盾 | 中 |
| 5.2 | `server/ha/connector.js:181-182` | 注释称 get_states 与 subscribe_events "二者绝不并发"，实际代码连续发出显然并发（见 4.7） | 中 |
| 5.3 | `server/scripts/runner-core.js:572-573`、`topology.js:25,99` | 注释仍引用已删除的 `ctx.task.watch`（同文件 :411 明确写"已删除 2026-11-28"） | 低 |
| 5.4 | `server/scripts/store.js:458` vs `worker-runner.js:26-29` | sim.log 口径矛盾：store 注释说"会话开始覆盖写"，worker 注释说"必须用 a 追加，否则抹掉主进程框架日志"，完整真相只在 executor.js:516-518 | 低 |
| 5.5 | `server/lib/runtime.js:2-3` vs `index.js:44`/`sse.js:21` | 注释称"避免到处传 ctx"，实际仍逐层传 `mcpCtx` | 低 |
| 5.6 | `server/mcp/tools.js:242` vs shape/store | description 称"每次必须传中文 name、严禁用 id 充当名字"，但 shape 是 optional，store.js:330 回退成 sid，工具不会报错 | 中 |
| 5.7 | `client/src/App.vue:72-73` vs `:411` | 注释说"不再用 shadowVersion/productionVersion 版本号比对"，发布按钮的显隐条件恰恰用 `scripts.shadowVersion === scripts.current.version` | 中 |
| 5.8 | `client/src/stores/scripts.js:3-4` vs `:150` | `unwrap` 注释称"所有 POST/DELETE 统一转异常"，stop() 是反例（见 4.4） | 中 |
| 5.9 | `client/src/App.vue:316` vs `:317` | 注释限定"只拦脚本发起的 HA 写"，横幅文案说"所有 HA 调用"，边界口径不一致 | 低 |

## 6. 文档描述不符和引用错误

> **✅ 已全部修复（2026-11-29 本轮）**：
> - **6.1 已修**：README 两处工具数改为"37 个工具（16 只读 + 8 受控写 + 11 仿真 + 2 面板控制）"，与 tools.js/mcp-tools.md 实测一致。
> - **6.2 已修**：SKILL.md 全文清理 `.notes` 引用（.notes 目录本不存在），"五个隐藏目录"改"四个"，决策历史落点改为"设计动机写进对应 references 章节"。
> - **6.3 已修**：SKILL.md 与 .scripts/README.md 统一为 `.scripts/<name>/`（去掉不存在的 lib 层）。
> - **6.4 已修**：README 删除指向不存在文件的 SCRIPT-SCENE-TAKEOVER.md 行。
> - **6.5 已修**：simulation.md 设计依据改为指向真实实现（`server/scripts/sim-control.js` + `server/sim/`），§1 表格的"报告 §14.7"引用一并清理。
> - **6.6 已修**：simulation.md 工具数改为"11 个仿真工具，含唯一切换入口"。
> - **6.7 已修**：mcp-tools.md submit_script 行补 `icon` 参数（新脚本首提必填 + 规范指引）。
> - **6.8 已修**：mcp-tools.md sim_inject 行补 `payload.params`。
> - **6.9 已修**：push-image.sh 两处命令名改为 `npm run image:nas` / `image:public`（与 package.json 一致）。
> - **6.10 已修**：SKILL.md 头部与 sync-cache.cjs 报错提示的作者本机绝对路径已去除。
> - **6.11 已修**：`sim_run_fixture` 追尾断言口径四处统一为代码实际行为（默认追加 since:0 与自带 assert 并存；仅 expected 为空且自带 assert 时不追加且 true 强制不了；assertWrites:false 显式关闭）——mcp-tools.md、simulation.md、tools.js 工具描述三处同步。
> - **6.12 已修**：SKILL.md 图标数去掉写死的 7447（改为"按版本缓存、随 MDI 版本变化"）；README 工具清单行补 case.cjs/mdi-icon.cjs/lib；compose 示例措辞改为"仓库 compose 的 build 形态换公开镜像后的样子"。
> - **6.13 已修**：pack-skill.cjs 头注释改为"源自旧命令、排除项比旧命令严（7 项 vs 1 项）"。
>
> 验证：npm test 300/300、前端 build 通过、start:dev 重启后 MCP get_system_info / list_scripts 与 REST 详情均正常，9 实例恢复。

| # | 位置 | 问题 | 严重度 |
|---|---|---|---|
| 6.1 | `README.md:36,158` | 称"25 个工具（15 只读 + 8 受控写 + 2 面板控制）"，实际 37 个（16 只读 + 8 + 11 仿真 + 2），整类仿真工具缺失，与 mcp-tools.md/tools.js 直接冲突 | **高** |
| 6.2 | `skill/SKILL.md:11,28,69,71,79,87,97,102,112,622` | 十余处引用 `skill/.notes/`、`cat skill/.notes/README.md`、`.notes/decisions.md`，并称"五个隐藏目录"——实测 `.notes` 目录不存在、只有 4 个隐藏目录，命令必报错，整章决策日志流程无法落地 | **高** |
| 6.3 | `skill/SKILL.md:77,82,95,110,622` vs `skill/.scripts/README.md:19-23` | `.scripts` 目录两套定义：SKILL.md 写 `.scripts/lib/<name>/`，实际与 README 都是 `.scripts/<name>/`（highpower-confirm 无 lib 层） | 中 |
| 6.4 | `README.md:223` | 链接 `[SCRIPT-SCENE-TAKEOVER.md]` 指向不存在的文件（断链） | 中 |
| 6.5 | `skill/references/simulation.md:3,19` | 称设计依据为项目根 `SIMULATION-DESIGN.md`（§5/§7/§14），该文件不存在，决策无法追溯 | 中 |
| 6.6 | `skill/references/simulation.md:44` | 写"11 个仿真工具 + 1 个切换入口"共 12，实际仿真 11 个是含切换入口的口径，与 tools.js/mcp-tools.md 冲突 | 中 |
| 6.7 | `skill/references/mcp-tools.md:67` | 号称完整清单但漏掉 `icon` 参数，而 tools.js:263 定义、SKILL.md/submit.cjs 均称新脚本首次提交必填——Agent 按此表调用会首提无图标 | 中 |
| 6.8 | `skill/references/mcp-tools.md:83` | `automation_sim_inject` 行漏列 `payload.params`（tools.js:478 定义） | 低 |
| 6.9 | `scripts/push-image.sh:7-8,36` | 注释与错误提示给 `npm run push:image:arm64` / `push:image:public`，package.json 实际是 `image:nas` / `image:public`，照抄会报 Missing script | 中 |
| 6.10 | `skill/tools/sync-cache.cjs:82`、`skill/SKILL.md:9` | 把作者本机绝对路径 `D:/Workbuddy/home/ha3d-automation` 写进可分发提示词/工具，换机器后失效 | 中 |
| 6.11 | `skill/references/mcp-tools.md:91`、`simulation.md:206` 与 `tools.js:618` | `sim_run_fixture` 的"追尾断言"行为 4 处文档互相矛盾（自带 assert 跳过 vs 不跳过）；且文档给的"传 assertWrites:true 强制追加"在用例自带 assert 且 expected 为空时无效（executor.js:1306 条件仍为 false） | 中 |
| 6.12 | `skill/SKILL.md:438`（图标数写死 7447）、`README.md:222`（工具清单漏 case.cjs/mdi-icon.cjs/lib/mcp.cjs）、`README.md:87`（示例称与仓库一致但与 docker-compose.yml 不符） | 描述过时/不精确 | 低 |
| 6.13 | `scripts/pack-skill.cjs:12` | 头注释称"与旧命令等价"，实际 SKIP_NAMES 排除 7 项而非旧命令的 1 项 | 低 |

---

## 附：本轮刚完成改动的复核

- `automation_get_system_info`（tools.js:24）：shape `{}`、handler 无参、返回字段不含 token/haUrl——与 SKILL.md:22-25、mcp-tools.md:27 描述一致，无问题。
- sse.js serverInfo 版本读 package.json（当前 0.1.41），与 tools.js、push-image.sh 同源；唯一小瑕疵是 PKG_VERSION 重复定义两处（见 2.3）。
- 工具数量 37 在三处（代码文件头、mcp-tools.md、实际注册）一致，但 README 没跟上（见 6.1）。
