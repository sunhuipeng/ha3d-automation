---
name: ha3d-automation
description: 在 ha3d-automation（HA 自动化托管平台，端口 8100）中开发新的自动化脚本。流程：① 前置环境检查 + 同步本地脚本缓存 → ② 需求合理性检查（与已有脚本比对冲突 / 重复 / 可合并，按需求性质判定扩展 / 合并 / 新建并给出依据）→ ③ 对话内需求流程图共创：读需求、实体集合、当前脚本或 flow.json，多轮在对话中画内联流程图并确认，未确认不写码 → ④ 按已确认流程图写脚本，再从 script.js 反推版本 flow.json（触发 / 条件 / 延时 / 动作 / 播报，不逐行也不笼统）→ ⑤ 提交影子版本（flow 与脚本 nodeId 交叉校验）→ ⑥ 影子验证两段固定节点：先进入仿真（simulate）跑一轮断言，再切回影子模式（follow）并启动影子版本真跑观察（写操作只记不下发）→ ⑦ 用户确认后发布正式版并重启验证。**发布正式版（真实控制设备）必须先经用户确认。** 触发词：开发脚本、写自动化脚本、新增脚本、新脚本、自动化脚本、迁移 HA 自动化、脚本冲突检查、脚本合并、该新建还是扩展、画流程图、确认流程图、需求流程图、ha3d-automation 脚本、8100 脚本、倒计时脚本、联动脚本、定时脚本、提交脚本、发布脚本、持续N秒、状态持续、重置计时、滑动窗口、影子验证、影子模式、仿真收尾、切回影子模式、同步脚本缓存、ctx.hold、持续确认容器、状态机封装、仿真验证、跑仿真、进入仿真、切仿真、simulate、验证方式、虚拟时钟、快进时间、注入实体、写意图断言、sim_run_steps、sim_inject、sim_advance、sim_snapshot、导出回归用例、fixture 重放、时间旅行、sim_rewind、复制影子版本、可复用脚本、用例回归、沉淀用例。
agent_created: true
---

# ha3d-automation 脚本开发流程

本 skill 指导 AI 在 ha3d-automation 平台（`http://localhost:8100`，项目目录 `D:\Workbuddy\home\ha3d-automation`）上开发新的自动化脚本，从需求到正式上线一条路走通。

**资料分工**：本文件是流程与硬规则的唯一现行版本；ctx 接口完整参考见 `references/ctx-api.md`；版本文件（script.js / flow.json / meta.json）规范见 `references/file-specs.md`；MCP 工具完整清单见 `references/mcp-tools.md`；**仿真（simulate）的完整用法、断言 DSL、踩坑清单见 `references/simulation.md`**；脚本骨架模板见 `templates/script-template.js`；**可复用脚本与仿真用例库存放在 `.scripts/` 与 `.fixtures/`（见下节）**。规范细节以 references 为准，本文件冲突时以 references 为准。

---

## 本地脚本缓存（skill/.cache）— 每条流程都从它开始

平台上的脚本都存服务端（`data/scripts/<id>/v<n>/`）。为减少来回请求、支持快速本地解析检索，本 skill 在 `skill/.cache/` 维护一份镜像：

```
skill/.cache/
├─ _index.json          # 机读索引：每个脚本的版本/状态/通道/sha256/依赖实体清单
├─ _index.md            # 人读索引表（scriptId / 名称 / 最新版本 / 状态 / 实体数）
└─ <scriptId>/v<n>/
   ├─ script.js         # 源码原文（与提交内容一致）
   ├─ flow.json         # 流程描述
   └─ meta.json         # 版本元信息
```

**同步命令**（增量，只拉有变化的版本）：

```bash
node skill/tools/sync-cache.cjs           # 增量同步
node skill/tools/sync-cache.cjs --all     # 连历史版本一起缓存（回溯/对比时用）
node skill/tools/sync-cache.cjs --force   # 忽略缓存全量重拉
```

**安装后第一次使用**：先跑一次 `node skill/tools/sync-cache.cjs --all` 预热——目录不存在会自动创建，把全部脚本（含历史版本）落到本地；之后日常只用增量同步。若 skill 被装到 agent 的 skills 目录（如 `~/.workbuddy/skills/ha3d-automation/`），缓存会建在该副本内，同样适用。

**时效规则（必须遵守，否则会基于过期代码做判断）**：

| 时机 | 动作 |
|---|---|
| 每次会话开始、第 0 步环境检查时 | 必跑一次增量同步 |
| 做需求冲突/合并分析前 | 必须已同步（不确定就先 `--force`） |
| 脚本写过之后（submit / publish / start 任一动作后） | `--force` 重拉，缓存立刻对齐服务端 |
| 读缓存发现版本旧、或用户说"我刚改过" | 以服务端为准，先同步再读 |

**使用约定**：读脚本、看流程、做冲突分析**一律先读缓存**（快、可 grep）；需要权威运行态（status / desired-running / 日志）时再查 API。**缓存是只读镜像，绝不手改缓存文件当交付物**，改脚本要改自己的源文件再提交。

---

## 可复用资产（skill/.scripts、skill/.fixtures）— 下次别从零写

两个**本地资产目录**（不进 Git；`scripts/pack-skill.cjs` 当前把它们列进 `SKIP_NAMES`，不打进 `skill.zip`，要带走请手动 `cp -r`）：

| 目录 | 放什么 | 怎么用 |
|---|---|---|
| `skill/.scripts/<name>/` | 已验证的脚本实现：`script.js` + 可选 `flow.json` + `note.md`（用途 / 出处 `scriptId vN` / 依赖实体 / 可调参数） | `cp -r` 出去改实体与参数；**不要直接改库里的文件当交付物** |
| `skill/.fixtures/<scriptId>/<用例>.json` | 可直接执行的仿真用例 DSL：`startAt` + `seed` + `steps`，可选 `expected.writes` | `case.cjs run` 一键回归；`case.cjs push --run-fixture` 走服务端重放 |

**开工前先看这两处**（比翻 `.cache` 里十几个业务脚本快得多）：

```bash
cat skill/.scripts/README.md            # 索引：有哪些可复用实现
node skill/tools/case.cjs list          # 索引：目标脚本已有哪些用例
grep -rl "ctx.hold" skill/.scripts      # 按判据形态找实现
```

**做完要沉淀**（否则库会空转）：

- 写出跑通的判据/结构 → 复制进 `.scripts/<name>/`、补 `note.md`、更新 `.scripts/README.md` 索引表；
- 仿真跑通一个场景 → `node skill/tools/case.cjs save <scriptId> <用例名>` 归档进 `.fixtures`，补 `note`、更新 `.fixtures/README.md` 索引表；
- 收录门槛：**验证通过 + 真被复用至少一次**；半成品、一次性业务脚本（留在 `.cache`）不收。

用例命令速查：

```bash
node skill/tools/case.cjs list                                  # 全部用例
node skill/tools/case.cjs run  <scriptId>/<name> [--continue] [--fail-fast]
node skill/tools/case.cjs push <scriptId>/<name> --run-fixture   # 服务端重放（同一目录，不复制）
node skill/tools/case.cjs save <scriptId> <name>                 # sim_export → 直接写进 .fixtures
node skill/tools/case.cjs finish <scriptId>                      # 仿真收尾：切回 follow 并确认影子在跑
```

`case.cjs run` 默认**重建虚拟世界**（`startAt`/`seed` 生效），跑完打印每条断言与终态写意图；用例带 `expected.writes` 时会追加一次 `since:0` 的全序列写意图断言（steps 里的 assert 已消耗游标，所以单独验）。

---

## 第 0 步：前置环境检查（必做，不通过不写码）

```bash
curl http://localhost:8100/api/health        # 服务存活；响应含 ha（连接状态）/ demo / devMode
node skill/tools/sync-cache.cjs              # 同步本地脚本缓存（必须）
node skill/tools/mcp-call.cjs automation_list_entities
```

- 服务没起：`(cd D:/Workbuddy/home/ha3d-automation && npm run start:dev)` 后台拉起，等 health 返回 ok 再继续。**本地只能用 `npm run start:dev`**（跨平台设置 `HA3D_DEV_MODE=true`），禁止 `npm start` / `node server/index.js`——开发模式跳过正式实例恢复的旧保证已取消，但本地仍禁止裸起服务避免误连正式环境。
- HA 未连接：告知用户，仍可在 demo 模式开发与影子验证，但**不发布正式版**。
- 同步失败（服务不可达）就不要往下走，先修服务。

### 双实例环境（本地开发 vs 正式环境）

家里只有一套正式 HA 时，正式环境（NAS 部署实例）与本地开发实例可能同时在线，二者通过环境区分：

| | 本地开发实例 | 正式环境（NAS） |
|---|---|---|
| MCP 地址 | `HA3D_MCP` 不设（默认 `http://127.0.0.1:8100/mcp/sse`） | `HA3D_MCP=http://<NAS地址>:8100/mcp/sse` |
| `HA3D_DEV_MODE` | `true`（脚本发起的 HA 写全拦截，正式实例只记日志不下发；身份/上下文仍按通道） | 不设 |
| publish | **允许**（影子可发布为正式；设备写仍被拦截，验证发布流程用） | 允许（发布后真实下发） |
| MCP 直调 HA | 不拦截（`confirmed:true` 的用户显式操作） | 不拦截 |

- **开发模式下**：脚本发起的所有 HA 写（含正式实例）只记日志、不下发；正式实例正常自动恢复、上下文写正式桶、可被影子读者读到。日志会标注 `[开发模式·拦截写操作]` / `[开发模式·拦截 HA 调用·未下发]`。
- **发布仍指向正式环境的 MCP 地址**：本地发布只验证"发布流程 + 上下文流转"，不会接管真实设备；真正的设备控制权在正式环境单独发布后才生效。
- 影子实例的语义不变：只记日志、上下文写影子桶（读仍统一读正式桶）。

## 第 1 步：需求合理性检查（先判断该扩展 / 合并 / 新建，再动手）

### 1.1 落三要素

| 要素 | 要问清的 |
|---|---|
| 触发 | 启动即生效？实体变化触发？定时（nowSod 比较 / ctx.after 周期）？ |
| 判据 | 阈值、模式、时间段、跨天边界 |
| 动作 | 每个 HA 服务调用的 domain/service/data；**实体值类动作要考虑影子模式下 HA 值不变的影响**（参考教训：依赖"自己改值驱动下一拍"的链路在影子下会断，改为脚本自持状态机） |
| 长驻 | 持续监听/循环 → `--kind=automation`（常驻）；一次性动作 → `--kind=script/scene`，自然结束 |

### 1.2 与已有脚本比对（读缓存，不凭印象）

```bash
cat skill/.cache/_index.md                                  # 全量脚本 + 依赖实体速览
grep -rl "light.bedroom" skill/.cache --include=script.js   # 实体级检索（换成本次相关实体）
grep -rn "nowSod\|ctx.after" skill/.cache --include=script.js | head -20   # 时间窗线索
```

逐项核对并写进结论：

| 冲突类型 | 判断方法 | 处理 |
|---|---|---|
| **实体冲突** | 同一实体被两个脚本写 | 必须合并成一个裁决者，或明确优先级/互斥条件；否则会互相打架（一开一关抖动） |
| **时间窗冲突** | 同一时段做互斥动作（夜间加热 vs 夜间关空调这类） | 加互斥判据，或合并成一个状态机统一裁决 |
| **逻辑包含** | 新需求是某脚本的子集/微调 | 通常扩展；但老脚本已过大或触发方式不同时，可新建并说明理由，不要无脑堆进去 |
| **判据重复** | 两个脚本各自订阅同一实体、同一阈值 | 抽一个脚本统一处理，或明确分工（一个只读一个只写） |
| **动作重复** | 同一服务调用 + 同一设备 | 合并，避免重复下发 |

### 1.3 三选一决策（按需求性质判定，三种都要有理有据）

先判断**需求性质**，再选动作。**没有默认选项**——"扩展既有脚本"不是首选，"新建"也不是，选哪个取决于需求落在下表哪一行。

**判定维度**（逐项过一遍，把结论记下来）：

| 维度 | 要回答的 |
|---|---|
| 业务语义 | 是不是同一个业务对象/同一个目标（同一台热水器 vs 另一个房间的灯） |
| 控制权 | 同一实体的"最终裁决者"是否必须唯一（互斥性要求） |
| 触发与生命周期 | 启动基线、订阅对象、长驻还是短驻是否一致 |
| 共享状态 | 是否需要共用同一个状态机 / `ctx.global` 上下文 / 倒计时队列 |
| 变更风险 | 改老脚本会不会把已稳定逻辑拖进回归；它是否正在线上跑、正在被依赖 |
| 灰度需求 | 是否需要独立版本、独立影子验证、独立回滚 |
| 规模上限 | 老脚本是否已接近可维护上限（节点 >6、主分支 >3、行数 >300） |

**决策表**：

| 需求性质 | 决策 | 依据 |
|---|---|---|
| 同一业务对象、同一实体域，且需要互斥裁决（同一台设备的第二条约束） | **扩展**（若只有 1 个脚本）或**合并改造**（若已有多脚本同写该实体） | 互斥必须在同一状态机内完成，跨脚本无法保证 |
| 同一脚本内加判据/加设备，既有控制流不动 | **扩展** | 复用基线、`expected`、`lock`，改动局部、回归面小、验证成本最低 |
| 新业务域/新设备组，实体不交叉，触发与生命周期独立 | **新建** | 独立版本与影子验证，风险隔离；塞进老脚本会让它膨胀成 god script |
| 语义相近但触发方式不同（定时 vs 事件驱动 / 启动即跑 vs 常驻监听） | **新建** | 生命周期不同，合并会让长驻/短驻语义打架，stop 与重启行为混乱 |
| 已有 2 个以上脚本互相冲突或重复下发，且后续还要迭代 | **合并改造** | 冲突不消除，每加一条需求都在放大问题；一次性收敛到单一裁决者 |
| 只是改阈值 / 时间 / 开关这类参数 | **不新建、不改代码**：优先看能否用 `input_number` / `input_boolean` / `input_datetime` 配置化 | 为参数变更产生新版本是不必要的版本噪音 |
| 需求本身不合理（与既有策略冲突、绕开 `ctx.write`、违反断线/实体删除兜底） | **先反馈用户，不硬做** | 例如要求直连 `callService`、要求断线期间强行下发，都属于必须拒绝的实现方式 |

**每条决策必须写三句话**（写进汇报，不能只给结论）：

1. 选了什么：扩展 `<scriptId>` / 新建 `<scriptId>` / 合并 `<A + B>` 为 `<C>`；
2. 为什么不是另外两个：各一句具体理由（如"老脚本已 6 节点且正在线上跑，再加两路分支超出可维护上限"）；
3. 代价与风险：如"扩展会触及夜间加热分支，需重点回归夜间时段与断线场景"。

**反模式（主动避免，也别照做）**：

- 什么都往老脚本塞 → god script：改一处崩一片，影子验证覆盖不全，回滚粒度变粗；
- 每个小需求都新建 → 碎片化：同一实体多脚本写入必抖动，日志分散难追；
- 为了"看着整齐"强行合并两个生命周期不同的脚本 → 长驻/短驻混居，启停与重启语义混乱；
- 用户明确要求某种做法时遵从用户，但必须把冲突点、风险点讲清楚再动手。

### 1.4 实体核对

逐一核对实体真实存在（`automation_list_entities` / `automation_get_state`），**禁止凭空猜测 entity_id**；影子验证时再核一次实际取值。

同时确认续跑语义：服务重启/重跑时先拉取 HA 当前值作为基线，不能当从零开始。

## 第 2 步：对话内需求流程图共创与确认（写码前门禁）

写码前先把需求、实体、现有脚本 / flow 放到对话里多轮讨论，画出**需求流程图**并取得用户明确确认。本步产出的是**对话内设计稿**，不是版本文件；未确认前禁止写 `script.js`、禁止提交任何 MCP 写操作。

### 2.1 先把材料读齐

输入可以是用户文字需求、MCP 拿到的实体集合、当前脚本 / flow.json、用户贴的流程图截图，可任意组合：

- **读脚本 / flow**：先读 `skill/.cache/<scriptId>/v<n>/script.js`、`flow.json`、`meta.json`；用户说"刚改过"或缓存版本明显旧时先 `--force` 同步。用户只给截图时，用图片查看工具逐节点识别 label / type / edge，识别不清的列出来问，**不脑补**。
- **读实体**：用 `automation_list_entities` / `automation_get_state` / `automation_get_history` 核对 entity_id、当前值、变化特征（如功率 PWM 周期、状态枚举大小写）。**禁止凭空写 entity_id**。
- **读需求**：把阈值、持续时间、通道、**每个状态变量的存储层（全局 / 本地 / 内存 / HA 实体）**与全局 key 值形态、HA 动作逐条落成可验证参数；"大于/小于/等于"的边界、断线 / unavailable 口径、重启基线都要问清或写明默认。**涉及"持续 N 秒"时，必须把"窗口内条件翻转即清零、重新满足从 0 计、到点复核"作为确认项列出；若回落也要防抖，必须单独确认 `unsatisfyMs`，否则默认不满足立即回落**，不能只写"持续 N 秒"四个字。

### 2.2 在对话里画图（不是交付物）

- 用对话内可视化能力（diagram 模块）画**内联 SVG 流程图**，按当前 IDE 主题渲染：暗色主题用深色底 + 浅色文字，禁止黑字落黑底。
- 图上的节点先按 `n_xxx` 命名，但在图注中明确写"**设计稿 nodeId，待脚本落地**"；此时不创建、不提交任何 `flow.json` 文件，也不手改 `skill/.cache/`。
- **每个改变走向的判据单独成节点**：即使"A 组 >800W"与"B 组开启"都写 `true`，也要拆成两个 `condition` 节点；B 组旁路直接连到 `action`，不要合并成"A 或 B"这种模糊条件。延时用独立 `delay` 节点，播报用 `announce` 节点。
- **"持续 N 秒"类判据：delay 节点标注"可重置"，并画出中断回边**（条件不再满足 → 回到 `condition` 从 0 重新计时）。确认表里必须写明"持续窗口 N 秒，中途判据翻转即清零、重新满足从 0 计，到点还要复核"；**若有回落时间，也要单列"不满足持续 M 秒才回落 / null 表示立即回落"**；**禁止画成"先查一次 → 到 N 秒后再查一次"的单向链**——那是错误语义，详见第 3 步硬规则第 4 条。
- 图后紧跟确认表，逐行列出：`节点 id / 类型 / 文案 / 判据参数 / 入边 / 出边`；另附 `实体清单`、`状态变量存储层（global / local / 内存 / HA 实体）与全局 key 值形态`、`边界口径` 三张小表。

### 2.3 多轮确认（硬门禁）

- 每轮只改用户指出的差异，改完**重新出图 + 重新出确认表**，并把"已确认 / 待确认"分开列。
- **没有用户明确"确认"之前，禁止写脚本源码、禁止调用任何带副作用的 MCP 工具**；只允许只读查询和继续画图。
- 用户确认后，把最终图固化为"需求契约"：三要素、节点 / 边表、参数表原样带进第 3 步作为编码依据。
- 若写脚本时发现契约无法直接实现（`ctx` 能力不足、AST 白名单冲突、影子语义矛盾），**回到本步重新出图确认**，不要私自改图凑代码。

### 2.4 与版本 flow.json 的边界（重要）

对话里的图是**需求设计稿**；版本 `flow.json` 仍在第 3 步由 `script.js` 反推生成。两者分工：

| | 对话内需求流程图 | 版本 flow.json |
|---|---|---|
| 回答什么 | 要画什么：节点拆分、分支、旁路、阈值 | 实际跑成什么：nodeId 必须是脚本里真实出现的字符串 |
| 何时产出 | 写码前，多轮讨论确认 | 脚本定稿后，随版本一起提交 |
| 是否交付 | 否，只在对话中展示 | 是，进 `data/scripts/<id>/v<n>/` |
| 校验方式 | 用户肉眼确认 | 提交器与脚本 nodeId 交叉校验 |

设计稿确认后写脚本时，**nodeId 必须沿用设计稿命名**；若实现需要增删节点或改边，先回到对话重新确认，再写脚本和版本 flow。

## 第 3 步：写脚本 + 从脚本反推版本 flow.json（硬规则，违反任一条 = 无法正常运行）

从 `templates/script-template.js` 骨架起手（若 `.scripts/` 里有形态相近的已验证实现，先 `cp -r` 出来改实体与参数，别从零写），遵守全部硬规则：

1. **写操作一律走 `ctx.write(op, desc, nodeId, ...args)`**，HA 调用只出现在 `ctx.actions({...})` 注册的函数体内。绝不裸调 `ctx.ha.callService` 做业务写。
2. **长驻脚本末尾 `await ctx.keepAlive()`**（常驻锚点，顶层永不结束，实例不被清理）；短任务脚本自然结束。
3. **循环/回调里检查 `ctx.stopped`**（布尔属性，不是函数），保证 stop 能退出。
4. **「持续 N 秒」= 滑动窗口重置语义（HA `for:` / `mode:restart`），禁止「先查一次 + 到点再查一次」**：
   - **优先用框架内置的 `ctx.hold`**（期待值/期待条件 + 双边计时 + 到点复核，详见 `references/ctx-api.md`）：
     ```js
     const high = ctx.hold({
       expect: (raw) => raw > 800,    // 期待条件：二态，不返回 null 三态
       satisfyMs: 3000,               // 满足期待持续 3s
       unsatisfyMs: 10000,            // 不满足持续 10s 回落；null/0/不传=立即回落
       nodeId: 'n_high_a',
     });
     ctx.watch([pWok, pOven, pRice], async () => {    // 实体订阅由脚本自己写，框架不内置监听
       const sum = (await ctx.ha.num(pWok)) + (await ctx.ha.num(pOven)) + (await ctx.ha.num(pRice));
       high.value = sum;                            // 实体变化由脚本写进 raw，从而触发重评
     });
     high.watch((satisfied) => {                     // (satisfied, prev, info)
       if (satisfied) ctx.write('setFlag', '大功率', 'n_write', true);
       // if (!satisfied) ... 只在需要回落动作时处理
     });
     ```
     期待值模式：`const a = ctx.hold({ satisfyMs: 30000, expect: true, unsatisfyMs: null }); a.value = true;`。满足持续 30s 回调一次 true；`a.value=false` 立即回调一次 false。
     **只接受对象参数**：数字首参、`ms`、`condition`、`fallMs` 等旧语法已删除，用了会直接抛错。
   - **只有 `ctx.hold` 不适用时**（如多组判据共享同一计时、需跨组互锁）才手写，照以下正例。注意下面与 hold 的语义差异，别照手写模板推断 hold 行为：
     - **语义差异（重要）**：手写模板是 HA `for:` 的单边语义——条件掉出即**立即清零**，下次满足从 0 计；`ctx.hold` 是**期待状态双边迟滞**——满足按 `satisfyMs`、不满足按 `unsatisfyMs` 分别计时，未到阈值回到当前状态只取消计时不回调，到点仍会重跑 expect 复核。两者"中断"口径不同，细节见 `references/ctx-api.md` §ctx.hold。
     - **手写语义**：条件必须**连续**满足满 N 秒才成立；窗口内任一时刻**判据结果翻转为不满足**（实体变化导致条件不再成立）→ 立即 `ctx.cancel(id)` 取消定时器、清零起点，下次重新满足时从 0 重新计时。多组条件各自独立一套起点/定时器，不能共用一个。
     - **反例（禁止）**：首次满足时排一个 `ctx.after(N, ...)`，中间不再重新评估，到点直接执行动作（或只到点复查一次）。这样"断断续续累计 N 秒"会被误判成"连续 N 秒"，正是用户最容易指出的错误。
     - **正例（照此写）**：
       ```js
       let since = 0, timer = null;
       async function evaluate() {
         const cond = await readCond();          // 每次都重新读实体重算判据
         if (cond) {
           if (!since) {
             since = Date.now();
             timer = ctx.after(N, async () => {
               timer = null;
               if (await readCond()) onConfirm(); // 到点复核，防最后一次推送后不再变化
             });
           }
         } else {
           since = 0;
           if (timer) { ctx.cancel(timer); timer = null; }  // 中断即清零，绝不累计
         }
       }
       ctx.watch(ids, () => { evaluate(); });     // 每次实体变化都重评，判据掉了就重置
       ```
   - **重置粒度**：以**期待结果（expect 投影）翻转**为准，不是实体任意数值抖动都重置。像 PWM 功率这种周期内反复波动的场景，只要判据（如"功率和 >800W"）仍成立就不重置；若按任何数值变化都重置，则永远无法确认持续时长。
   - `ctx.every` 只用于固定频率兜底/清理，**不用于"持续 N 秒"判定**；手写时 `ctx.after` 返回的 id 必须保存，重排或中断前先 `ctx.cancel(id)`。
5. **防自发自收**：用 `expected` 表记录自己期望的实体值，在 watch 回调里过滤自己引起的 变化。
6. **启动先拉当前值基线**（`ctx.ha.num/state`），续跑语义成立。
7. **防重入用 `ctx.lock`**（忙跳过不排队）。
8. **禁止无限/无界循环**（`while(true)`、无退出条件的 `while`/`for` 等）：inline 单进程模式下同步循环会阻塞其他所有脚本。等待一律异步让出：长驻用 `await ctx.keepAlive()`，延时用 `await ctx.sleep(ms)` / `ctx.after`，周期兜底用 `ctx.every`（回调里检查 `ctx.stopped` 让步）。
9. **断线保守分支**：用 `ctx.invalid(v)` 统一判无效（`null`/`''`/`unavailable`/`unknown`/`none`/`NaN`，见 `ctx-api.md`），不要再各自抄 `INVALID` 数组。数字值直接 `await ctx.ha.num(eid, fallback)`——传 `null` 表示读不到就跳过、传安全数值表示读不到继续；**别用 `ctx.num`（非数字一律吞成 0）表达"读不到"**。`ctx.ha.state` 原样返回字符串，由脚本自己判有效性。判据读到无效值时按业务选保守策略（跳过 / 保持上次事实 / 写安全值），不能拿无效值推进计时或触发动作。
10. **禁用清单**：`require`/`import`/`process`/`fetch`/`eval`/`fs.*`/`.constructor` 等——完整清单见 `references/ctx-api.md` 第一节，提交时 AST 校验会拦。
11. `scriptId`：`/^[a-z0-9_-]+$/i`，业务语义命名；`nodeId` 用 `n_xxx`。
12. **版本模型**：影子 = 可反复修改的工作副本（重新提交**原地覆盖**，版本号不变、revision+1）；正式版 = 内容不可变；归档 = 历史（分曾上线 / 试错废弃）。**正式与影子可各运行一个实例并行（互不影响：影子设备写只记日志、上下文写影子桶；正式写正式桶）；发布后收敛为只剩一个正式实例**。改正式内容只能提交新影子再发布，回滚走 `automation_rollback`（也产生新影子版本）。版本号只增不减。
13. **依赖其他脚本**：不写配置式 `dependsOn`。脚本开头用 `await ctx.task.require('depId', { timeout })` 等依赖的**正式实例**就绪，再用 `ctx.watch.task('depId', cb)` 订阅后续状态变化；读侧不隔离——影子实例在跑不算就绪，接口返回 `mode` 恒为 `production`。全局上下文同样读不隔离（`ctx.global.get/watch` 统一读 `production`）、写仍隔离（`ctx.global.set` 按调用者模式落桶）。注册即回放当前状态，依赖重启抖动由业务侧防抖；依赖不健康时由脚本自己的判据短路写操作。一次只维护一个脚本，发布后其他脚本自然读到值。接口细节见 `references/ctx-api.md`。
14. **运行时拓扑是观测出来的，不是写出来的**：平台自动在 executor 真实拦截点记录脚本读/订阅的实体（`getState`/`subscribe`）、调用的 HA 服务（`callService`）、读取/订阅的上下文（`contextGet` / `contextSubscribe`）、写入的上下文（`contextSet`），按 `scriptId + 通道 + 版本` 分组存**纯内存**（不落盘，服务重启后从零重新观测，运行中脚本恢复实例时会秒级重建），换版本自动重置，前端详情页展示。**脚本里不要写任何拓扑声明字段/接口**——不手写依赖清单，不从上下文读拓扑。数据只在脚本真实跑过后逐步完整，未触发的分支不会出现；影子模式下 `ctx.write` 在脚本层被拦、动作函数不执行，所以"修改实体"观测不到是预期，读实体、上下文读取与写入照常记录。要查拓扑用 `GET /api/script/:id/topology`，不要静态猜。
15. **状态存哪里按消费者分层，不按重要性**：跨脚本共享（别的脚本要读/写）的事实/裁决结果 → `ctx.global`；只有本脚本读但重启后要恢复的 → `ctx.local`；只有本脚本读、重启可重算的纯过程变化 → **脚本内普通变量**（计时起点、`expected` 表等，不要为了"持久化"滥用上下文）；人要改/人要看的配置 → HA `input_*` 实体，**不进上下文**。影子写入隔离、读取统一读正式桶，别依赖"影子写后自己读回"。详细判据与例子见 `references/ctx-api.md` 的「先选存储层」。

### 3.1 版本 flow.json 按 script.js 反推，画关键节点（不逐行，也不笼统）

flow 是执行逻辑的**投影**：让人一眼看懂「谁触发、按什么判断、等什么、做了什么、说了什么」。完整规范见 `references/file-specs.md` §flow.json，这里只列最容易踩的：

1. **先码后图**：此处专指**版本 flow.json** —— script.js 定稿后再反推，禁止先写 flow 文件再凑脚本；对话内需求设计稿见第 2 步，不在此列；
2. **采集真实 nodeId**：
   ```bash
   grep -oE "'n_[a-z0-9_]+'" <脚本源文件> | sort -u     # 脚本里实际用到的节点
   ```
   每个 nodeId 必须是脚本里 `ctx.log` / `ctx.write` 第三参真实出现过的字符串；写不出对应脚本节点的，就是假节点，要么删掉要么脚本里补 `ctx.log(nodeId)`。nodeId 一职三用：`ctx.write` 的**位置参数**（不可省，省了动作参数错位）、flow 校验锚点、日志归组 + 画布运行态高亮（error 红/其余绿）——不要为高亮效果加无业务含义的日志或节点。画布本身只读（无拖拽/连线/编辑，无画布类 MCP 工具），改图只能改 flow.json 随版本提交；
3. **关键节点必须出现**：**触发** `trigger`（启动/定时/订阅）、**条件** `condition`（每个改变走向的判据）、**延时** `delay`（`ctx.after`/等待/冷却）、**动作** `action`（`ctx.write` 设备控制）、**播报** `announce`（label 以 `播报：` 开头、`nodeId` 用 `n_announce_xxx`）；必要时补状态标记与恢复终态。**不同文案或时机的播报各占一个节点**（如「已热」「开烧」「完成」三条播报就画三个节点），别并成一个"播报通知"；
4. **粒度**：简单脚本 3~5 个、一般 5~10 个、复杂状态机可到 12 个；同类动作合并，不画内部函数、日志、`expected` 过滤；label 用中文短语说清"什么条件下做什么"，单条 ≤20 字，播报把实际文案写进 label；
5. **按控制流连边**：`edges` 反映真实分支（启动基线 → 判据 → 动作 / 事件 → 动作），扇入扇出照实画，恢复路径画回边，不必为每次日志或复核画回环；默认不写 `layout`（前端 dagre 自动布局）；
6. **脚本改版必须同步改 flow**，一起提交，不能只改脚本。

提交器会做交叉校验：flow 里的节点在脚本中不存在 → 直接拒绝；脚本里有 nodeId 没进 flow → 警告。

## 第 4 步：提交影子版本

```bash
node skill/tools/submit.cjs <scriptId> "<脚本名>" <脚本源文件路径> <flow.json 路径> "<版本说明>"
# 等价 MCP：automation_submit_script（channel=shadow, kind=automation）
```

- **脚本名（name）必须贴切**：每次提交都要传一个描述业务用途的中文名（如「空调运行关门预警」「厨房电器状态播报」），**严禁用唯一 id（如 s3acdoor）充当名字**——id 只作标识，用户在前端看到的是 name；
- **name 可随迭代演进**：脚本职责变化时同步更新 name，让它始终概括当前功能（改名走正常提交即可，不算破坏不可变）；不传 name 会继承上一版的值，若上一版已是 id 则永远错下去；
- **影子是工作副本，可反复修改**：已有影子时重新提交 = **原地覆盖**（版本号不变、revision+1），不会新增版本号；只有想另起候选版（如分支试验）才加 `--new-version`；
- **宿主覆盖（可选）**：个别脚本需要单独指定执行宿主时加 `--host-mode=fork|inprocess|worker`（等价 MCP 参数 `hostMode`）。典型场景：全局 `inprocess` 下把高频计算的重脚本覆盖为 `fork` 独享子进程。跟随版本持久化、后续迭代自动继承；不传则按默认策略选宿主（2026-11-26 热池改造：正式一次性动作/场景自动走热池会话，常驻自动化跟随全局 `EXECUTION_MODE`）。影子恒为专属 worker（每次新建、用完即毁），此参数只影响发布后的正式实例；
- **业务种类（`--kind=automation|script|scene`）**：业务种类同时决定运行模型——`automation`=常驻自动化（默认，常驻运行、由 start 管理、无一次性看门狗）；`script`/`scene`=一次性动作（跑完即退、有看门狗、供 Home 面板或自动化脚本按次触发）。与宿主模式同策略：不传则继承上一版，全新脚本默认 `automation`。等价 MCP 参数 `kind`。一次性脚本正文直接顺序执行动作、自然结束，**不要写 `ctx.keepAlive()`**；
- **图标（`--icon <icon.svg>`）**：**新脚本首次提交必须提供**（后续迭代不传则自动继承上一版）。按脚本业务画隐喻图形（如热水器=水滴+波纹、空调=出风、夜灯=月亮），本地存 `icons/<scriptId>.svg` 后用 `--icon` 传入（MCP 等价参数 `icon`，值是 SVG 源码字符串）。规范与绘制细则见 `references/file-specs.md` §icon；服务端做安全校验（拒绝 script/事件属性/外链引用）；
- 改的是**正在运行**的影子会先被服务端自动停止，需重新 start 才生效；
- flow 文件是**必填**：只做链路联通测试时可显式加 `--placeholder`（写入通用三节点模板，正式交付前必须换真图）；
- 提交成功后立即 `node skill/tools/sync-cache.cjs --force`，让缓存对齐新内容（影子内容会变，缓存靠 sha256 比对，不要只看版本号）。

**提交完不要先 `start` 观察**：影子版本到手后，固定顺序是「5.1 进仿真跑一轮断言 → 5.2 切回 follow → 5.3 影子真跑」。先 follow 再仿真等于多停一次实例，也容易漏掉仿真这段。

## 第 5 步：影子验证（验收门禁）— 先仿真，再影子真跑

影子通道固定，但验证是**两段固定节点**，顺序不能省、也不能只做前一段：

```
第 4 步 提交影子版本
   ↓
5.1 进入仿真（simulate）   虚拟实体 + 虚拟时钟，秒级跑完一轮，断言流程/时序/写意图
   ↓  仿真通过 ≠ 可以上线；仿真也不是流程终点
5.2 切回影子模式（follow） 一条命令停仿真 + 以 follow 重启同一个影子版本（收尾固定动作）
   ↓
5.3 影子真跑（follow）     真实基线、真实触发、真实时序，写只拦截不下发 —— 真正的验收门禁
   ↓  两段都通过 + 用户确认
第 6 步 发布正式版
```

为什么两段都得走：仿真用的是虚拟实体，**不模拟设备不响应、失败、延迟**，它只证明「流程走得到、判据算得对、写序列不错」；`follow` 才证明「真实实体读得对、真实触发真的会来」。只跑仿真就发布 = 拿模拟器结论给线上背书。

| 方式 | 阶段职责 | 能验证什么 |
|---|---|---|
| `simulate`（仿真） | 第一段：分支覆盖与时序回归，可重复、秒级 | 流程 / 时序（虚拟时钟）/ 写意图；**不模拟设备不响应、失败、延迟** |
| `follow`（影子模式） | 第二段：真实环境验收 | 真实实体值 + 真实触发 + 真实回调时序；慢，需要人配合造条件 |

三条边界（硬规则）：
- 仿真**不造假失败**。要看"设备没响应脚本怎么办"，在 `follow` 下用真实设备跑——这类异常分支只在那里能验。
- 仿真只覆盖本脚本，不联动其他脚本；依赖脚本状态用 `inject_task` 造。
- **仿真通过 ≠ 线上可用**：`publish` 前必须在 `follow` 下用真实设备跑一轮（5.3），不接受"仿真全绿就直接发布"。

### 5.1 进入仿真（simulate）— 第一段：流程 / 时序 / 写意图

前置：目标脚本必须有**影子版本**（正式版内容不可变）。正式版要验证就先复制：`automation_submit_script` 带 `newVersion:true` + `channel:'shadow'`，源码/flow/icon/kind 原样带上，复制后校验 `script.js` sha 与原版一致。

```bash
# ① 切仿真 + 种子（用真实 entity_id，状态枚举照抄；时间型脚本把 startAt 落在业务窗口边界）
node skill/tools/mcp-call.cjs automation_switch_verify_mode '{
  "scriptId":"<id>","mode":"simulate","startAt":"2026-11-26T20:50:00+08:00",
  "seed":{"entities":{"sensor.p":{"state":"0"}},"context":{"global":{},"local":{}}},
  "confirmed":true}'

# ② 看启动瞬间：写意图（硬证据）+ 日志 + 此刻在等什么
node skill/tools/mcp-call.cjs automation_sim_snapshot '{"scriptId":"<id>","include":["writes","logs","execution"],"confirmed":true}'

# ③ 先跑已有可复用用例（有的话）：重建世界 + 逐步断言 + 全序列写意图校验
node skill/tools/case.cjs list
node skill/tools/case.cjs run <scriptId>/<用例名>

# ③' 新写/临时用例：放 skill/.fixtures/<scriptId>/<name>.json 后同样 run；也可直接喂 MCP
node skill/tools/mcp-call.cjs automation_sim_run_steps "$(cat case.json)"

# ④ 跑通后归档成资产（sim_export → skill/.fixtures），或推给服务端重放
node skill/tools/case.cjs save <scriptId> <用例名>
node skill/tools/case.cjs push <scriptId>/<用例名> --run-fixture

# 收尾 → 直接进 5.2（不是 sim_close）：切回 follow 并确认影子在跑
node skill/tools/case.cjs finish <scriptId>
```

验证清单：

- [ ] 断言 `ok=true`，`passed/total` 全通过（失败点看 `checks[].expected` 与 `actual`）；
- [ ] 写意图时间点与判据边界吻合（如 2999ms 不写、3000ms 写），终态上下文符合预期；
- [ ] 无 `脚本异常` error 日志（仿真崩溃现场保留在 `data/runtime/<id>/v<n>.sim.crash.json`，只读）；
- [ ] 用例已归档到 `skill/.fixtures/<id>/<用例名>.json`（`case.cjs save`），`case.cjs run` 全绿；推服务端重放时 `versionDrift=false` 且写意图序列一致。

**断言速记**：`ctx.write` 一次产生**两条**写意图（`service` + `write`），`ctx.global.set` 也会产生 `kind:'context', op:'contextSet'` —— 断言序列别漏；`writes` 是「自上次断言以来新增 + 全序列等长逐条部分匹配」；`expect` 是路径 DSL（`writes[0].op`、`context.global["x.y"]`、算子 `eq/gte/includes/exists/type`，可 `all/any/not`）。`sim_run_steps` 默认重建世界，`continue:true` 才续跑且与 `startAt/seed` 互斥。其余坑（Date 桥接、fixture 缺 advance、entities 默认只含用过的）见 `references/simulation.md` §7。

### 5.2 切回影子模式（follow）— 仿真的收尾，固定动作

仿真跑完**不要停在 simulate**：`publish` 前必须让同一个影子版本回到真实环境跑一轮，所以切回 follow 是流程节点，不是可选清理。

```bash
# 一条命令：停仿真实例 → 以 follow 重启同一影子版本 → 查状态兜底启动 → 打印最近日志
node skill/tools/case.cjs finish <scriptId>
```

等价的底层两步（`finish` 内部就是它们 + 校验）：

```bash
node skill/tools/mcp-call.cjs automation_switch_verify_mode '{"scriptId":"<id>","mode":"follow","confirmed":true}'
node skill/tools/mcp-call.cjs automation_get_script_status '{"scriptId":"<id>"}'
```

校验清单：

- [ ] 切换返回 `to:"follow"`、`version` = 影子版本号（不是正式版号），`idempotent:true` 表示本来就在 follow；
- [ ] `runningVersions` 里存在 `mode:"shadow"` **且** `verifyMode:"follow"` 的实例 —— 只是"切了模式"但没在跑，等于没验；
- [ ] `status=running`，版本日志开头有 `runner 启动 vN｜模式=影子`、基线拉取（`写入全局 …｜启动基线`），没有 error；
- [ ] 此后的写操作只出现 `[影子·拦截写操作]`，**绝无** `[真实写操作]`；
- [ ] 仿真日志 `v<n>.sim.log` 停止增长，之后看的都是真实日志（`GET /logs?source=sim` 是仿真专用）。

三条硬规则：

- **不要用 `sim_close` 收尾**：它只销毁虚拟世界并停实例，不会回 follow，验证链会断在这里。它只适合"这批用例不打算继续验了、先收摊"。
- **切回 follow 后不要 stop 影子**：影子必须一直 running 才能观察真实触发；停掉就等于跳过 5.3 这道门禁。
- 虚拟世界随 worker 退出自动销毁、不持久化；要复现靠 `skill/.fixtures` 里的用例，不靠"留着仿真会话"。

### 5.3 影子真跑（follow）— 验收门禁

```bash
# 常驻自动化（kind=automation）：跑起来后观察（5.2 已启动，这里只在被外部停过时补）
node skill/tools/mcp-call.cjs automation_start_script '{"scriptId":"<id>","version":<影子版本号>,"confirmed":true}'
# 一次性动作/场景（kind=script/scene）：按次触发影子版（跑完自动清理，写不下发）
node skill/tools/mcp-call.cjs automation_trigger_script '{"scriptId":"<id>","channel":"shadow","confirmed":true}'
node skill/tools/mcp-call.cjs automation_get_logs '{"scriptId":"<id>","mode":"shadow"}'
```

- 常驻自动化：`start` 后**保持运行**，请用户在 HA 侧造真实触发条件，隔一段时间回来看日志；
- 一次性动作/场景：`trigger` 一次跑完即退，可以反复触发；
- 补 start 时**必须点名影子版本号**：不传 `version` 会取最高版本，正式版号更高时会误启正式实例。

验证清单（全部满足才算通过）：

- [ ] 启动日志出现 `runner 启动 vN｜模式=影子` 与基线拉取（不是仿真种子值）；
- [ ] 写操作只出现 `[影子·拦截写操作]`，**绝无** `[真实写操作]`；
- [ ] 触发 → 判据 → 动作链路完整走通（真实实体值符合预期，不是仿真种子）；
- [ ] 反复触发不产生重复下发（lock / expected 生效）；
- [ ] 无 `脚本异常` error 日志。

不满足则修改脚本源码 → 重新提交（**原地覆盖当前影子**，版本号不变）→ **从 5.1 重跑仿真，再 5.2 切回、5.3 重验**。影子阶段随便改，不消耗版本号。

## 第 6 步：发布正式版（**必须先经用户确认**）

前置：**5.1 仿真全绿 + 5.3 影子真跑通过**，且此刻影子实例已切回 `follow` 并在运行（`case.cjs finish` 的结果）。只有仿真结果、或影子停在 simulate，都不算通过。向用户展示仿真断言摘要 + 影子真实日志摘要，**明确确认后**才执行：

```bash
node skill/tools/mcp-call.cjs automation_publish_script '{"scriptId":"<id>","version":<n>,"confirmed":true}'
node skill/tools/sync-cache.cjs --force
```

- 发布 = 影子转正式（同版本号），旧正式自动归档；**正式版内容不可变**；
- 若另一版本正在运行，服务端**自动切换实例**：停旧 → 以影子身份启动新 → 热切为真实下发；新版本起不来会自动回退旧版本（返回体 `switchedFrom` 会标注）——不需要也不应该再手动 start/stop；
- 回滚：线上出问题时用 `automation_rollback {"scriptId","fromVersion","confirmed":true}` 读历史版本文档 → 提交为**新影子版本**（版本号继续递增、不自动上线）→ 重新走影子验证 → publish。

正式版会**真实控制设备**。发布后再拉一次日志确认 `[真实写操作]` 符合预期，并建议用户在 HA 前端核对设备实际状态。

## 第 7 步：收尾汇报

汇报内容：**决策三句话（选了什么 / 为什么不是另外两个 / 代价与风险）与比对过的脚本清单**、**第 2 步确认过的需求流程图最终版（节点 / 边 / 参数表）及确认轮次**、scriptId 与最终版本号、三要素落地方式、版本 flow 与脚本 nodeId 对应关系、验证结果（`simulate` 写清起点时刻与种子、断言通过数、写意图时间点、归档的用例名 `skill/.fixtures/<id>/<name>.json`；`follow` 写清已切回影子模式、影子版本号与运行状态、关键真实日志）、正式版运行状态、依赖实体清单（查单脚本运行拓扑 `GET /api/script/:id/topology`，脚本跑过后才有数据）、注意事项（如断线行为）。

---

## MCP 能力灵活运用（面板反馈链 + 验证链）

原则：**动作之后让用户屏幕上立刻看到最新状态**；能用精准刷新就不粗粒度刷，能复用动作自带的自动广播就不重复调。

### 面板反馈链（按动作选择）

| 刚做完什么 | 跟进的 MCP 调用 |
|---|---|
| 提交/覆盖影子、发布、回滚 | 服务端已自动广播 `scripts` + `script`（列表 + 正文/流程图/版本条/日志），**通常无需额外调用**；仅当返回后前端状态未对齐（如错过广播）才补 `automation_refresh_panel {"what":"all"}` |
| start / stop（启停实例） | `automation_refresh_panel {"what":"scripts"}`（列表徽标）＋ 右侧正开着该脚本时补 `{"what":"logs"}` |
| 想让用户聚焦某脚本人工验证 | `automation_select_script {"scriptId","version"}`（选中即打开详情，列表与右侧同时刷新，视线直达） |
| 只改了日志想看新输出 | `automation_refresh_panel {"what":"logs"}` |
| 找不到对应维度的精准刷新 | 退化顺序：`select_script`（列表+右侧都刷）→ `refresh_panel {"what":"all"}` |

### 验证链（验证影子/正式效果时组合使用）

1. `automation_list_scripts`：摸清每个脚本的通道（正式 vN / 影子 vN）与运行实例，**提交前必看**（也是 1.3 决策的依据）；
2. `automation_get_logs {"scriptId":"<id>","mode":"shadow"|"production"}`：按通道读日志（scriptId 必填），别猜版本号；**仿真实例的日志是独立文件**（`v<n>.sim.log`，时间列是虚拟时刻），用 `automation_sim_snapshot` 的 `logs` 或 `GET /api/script/:id/logs?source=sim` 读，别拿真实日志判断仿真结果；
3. `automation_select_script` + `automation_refresh_panel`：把你正在验证的脚本带到用户面前；
4. `automation_get_script_status`：确认运行实例、暂停原因、HA 连接状态；`runningVersions[].verifyMode` 区分该影子实例是 `follow` 还是 `simulate`；
5. **仿真收尾**：`switch_verify_mode {"mode":"follow"}`（或 `case.cjs finish <id>`）→ 再查一次状态，确认 `mode:"shadow"` + `verifyMode:"follow"` + `status:"running"` 三者同时成立，然后才去 5.3 造真实触发；停在 simulate 或切了模式但实例没起来，都算没验完。

### 其他灵活运用的要点

- **提交前**：`automation_list_scripts` 查重与冲突（1.3 决策）、`automation_list_entities` / `automation_resolve_entities` 确认依赖实体真实存在；
- **别重复调用**：submit/publish 本身已自动广播刷新与列表更新，除非不确定前端是否在线，否则无需紧跟两次 all；
- **报错先读返回体**：MCP 工具的失败信息（槽位占用、flow 校验、sha 不符）都写了原因和修法，先按提示处理再重试；
- **写操作永远带 `confirmed:true`**，只读工具不要带。

---

## 环境注意

- Bash 会话 cwd 固定在 `D:\Workbuddy\home`，`cd` 前缀可能被剥离，用子 shell `(cd ha3d-automation && <cmd>)` 最稳。
- 测试跑法：`(cd ha3d-automation && npm test)`（node:test，测试位于顶层 `tests/`）。
- 改动服务端代码（runner/executor/store）不在本 skill 范围；只做脚本开发时**不要重启服务**（会按运行意图清单恢复，但正在验证的影子实例会重跑）。
- 可复用资产在 `skill/.scripts/`（脚本实现）与 `skill/.fixtures/`（仿真用例）——**用例目录同时是服务端 `sim_export` / `sim_run_fixture` 的读写目录**，不再有 `data/fixtures`；已 `.gitignore`，`pack:skill` 也跳过；**只增不删**，删之前先确认没有脚本在用例里引用。
- 崩溃现场 `data/runtime/<id>/v<n>.sim.crash.json`（只读）是运行数据：别清理、别手改成"通过"。
- **仿真是临时状态**：影子实例的常态是 `follow`。`simulate` 只在 5.1 存在，跑完必须 `case.cjs finish` 切回 follow 并保持运行；服务重启后仿真实例也会恢复成 follow（虚拟世界不持久化，别指望"留着会话"复现，复现靠 `.fixtures` 用例）。
- `skill/.cache/` 是运行时缓存，已加入 `.gitignore`，不要提交。
