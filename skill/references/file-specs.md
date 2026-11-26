# 版本文件规范

每个脚本按版本存储于 `data/scripts/<id>/v<n>/`，三文件：`script.js` / `flow.json` / `meta.json`（均为原子写 tmp + rename，由 store 维护，**不手改**）。

## script.js

- 提交的脚本源码**原样存储**（含注释），不做转译；
- **版本不可变**：修改脚本 = 提交新版本（v 自增），旧版本保留可回滚。

## flow.json — 画布展示数据（只读，不可编辑）

flow 是脚本执行逻辑的**投影**：让人一眼看懂「谁触发、按什么判断、等什么、做了什么、说了什么」。既不是逐行代码图，也不是"启动 → 判据 → 动作"一句空话。

```json
{
  "version": 1,
  "scriptId": "s2countd",
  "nodes": [
    { "id": "n_start",    "type": "trigger",   "label": "启动拉取基线 / 实体变化" },
    { "id": "n_eval",     "type": "condition", "label": "水温低于目标且未规避" },
    { "id": "n_delay",    "type": "delay",     "label": "等待 10s 确认" },
    { "id": "n_announce", "type": "announce",  "label": "播报：热水器开起啦，主人" },
    { "id": "n_act",      "type": "action",    "label": "开热水器并恢复保温" }
  ],
  "edges": [
    { "from": "n_start", "to": "n_eval" },
    { "from": "n_eval", "to": "n_delay" },
    { "from": "n_delay", "to": "n_announce" },
    { "from": "n_announce", "to": "n_act" }
  ]
}
```

| 字段 | 规范 |
|---|---|
| `nodes[].id` | 脚本内 `ctx.log` / `ctx.write` 的 `nodeId` 与之对应（`n_xxx` 前缀），日志按节点归组 |
| `nodes[].type` | 仅 `trigger` / `condition` / `delay` / `action` / `announce` 五种（服务端校验，其他值提交即被拒）。`announce` = 播报节点（粉色 ♪ 角标） |
| `nodes[].label` | 展示文案，见下方「label 写法」 |
| `nodes[].layout` | 画布坐标，**默认不写**：任一节点缺失时前端用 dagre 自动布局（左→右分层 + 消交叉 + 按卡高对齐，多入多出不会重叠）；写了则以给定坐标为准 |
| `edges` | `from` → `to` 的 node id |

### 关键语义节点（图上至少要看得见这些）

服务端共五种 type，前端按 type 着色并显示角标（触发 / 条件 / 延时 / 动作 / 播报）。**播报有独立类型 `announce`**：写 `type:'announce'`，label 以 `播报：` 开头、`nodeId` 用 `n_announce_xxx`，画布上会以粉色 ♪ 角标凸显"这一步在说话"。（旧版本里用 `action` + `播报：` label 的图仍可正常展示，但新写的 flow 一律用 `announce`。）

| 语义角色 | 落到 flow | 何时单独画 |
|---|---|---|
| 触发 | `trigger` | 启动基线、定时器、实体订阅各占一个；同类合并 |
| 条件 | `condition` | 每个**改变走向**的判据：阈值、模式、时间窗、规避命中、是否达标 |
| 延时 | `delay` | `ctx.after` / `ctx.sleep` / 等待确认 / 冷却，画在等待真正发生的位置 |
| 动作 | `action` | `ctx.write` 的设备控制、配置写入；连续几个同类动作合并成一个节点 |
| 播报 | `announce`，label `播报：` 开头 | **不同文案或不同时机的播报各占一个节点**（如「已热」「开烧」「完成」三条播报画三个节点），不许并成一个笼统的"播报通知" |
| 状态标记 | `action`，label `标记：` 开头 | 仅当它影响后续走向时画（如 `bath.doneDate` 当日达标标记） |
| 恢复 / 终态 | `action` | 状态机回到稳态（恢复保温、清标记、退出规避）时画一个 |

### 绘制粒度：不逐行，也不笼统

- **要画**：改变走向的判据、用户看得见/听得见的动作、有等待的延时、状态机终态；能回答"这个脚本到底管什么"。
- **不画**：内部函数调用与日志、`expected` 自发自收过滤、同一动作的多处调用点、连续数条 `ctx.write` 的逐条明细（合成一个动作节点）。
- **数量**：简单脚本 3~5 个；一般 5~10 个；复杂状态机可到 12 个（例：热水器总控 12 节点）。**超过 12 个**先删冗余节点，检查是不是把逐行逻辑搬上来了；确实复杂就只保留主干 + 关键分支。
- **label 写法**：中文短语说清"什么条件下做什么"，单条 ≤20 字；播报节点把实际文案写进 label，如 `播报：已经是热水啦，主人`。
- **边**：按真实控制流连主链 + 关键分支，同一判据多路结果画扇出、恢复路径画回边；不必为每次日志或复核画回环。

### 画布与运行态的联动（只读联动，随产品固化）

画布是**只读投影**：禁止拖拽 / 连线 / 选中 / 删除，仅允许缩放平移；没有画布编辑类 MCP 工具，flow.json 是唯一数据源，改图只能改文件重新提交。

节点与运行代码之间有两条**只读联动**，全部由 nodeId 驱动，脚本侧不需要任何额外工作：

| 联动 | 触发 | 表现 |
|---|---|---|
| 日志归组 | `ctx.log` / `ctx.write` 带 nodeId | 日志按 nodeId 结构化落盘，MCP `get_logs` 返回的对象带 nodeId |
| 运行态高亮 | WS 日志事件推送到前端 | 命中 nodeId 的节点亮状态标记：`error` 红点 + 红描边，其余绿点；脚本重新 running、切换脚本/版本时清空（防串图） |

由此对 nodeId 的三点硬要求（与上方交叉校验叠加）：

1. **不可省略**：`ctx.write(op, desc, nodeId, ...args)` 中 nodeId 是位置参数，省略会让 `...args` 整体前移一位，动作函数会收到错误参数（如把 `'n_window'` 当温度）；
2. **不造假**：每个 nodeId 必须真实出现在脚本源码里（提交器硬校验，缺了直接拒绝）；
3. **不加戏**：不要为了高亮效果添加无业务含义的 `ctx.log` 或节点——日志是排障维度，画布联动只是顺带消费。

**flow 必须由 script.js 反推**，它是执行逻辑的投影而非示意图：

1. 先定稿 script.js，再画 flow（禁止先画图后凑代码）；
2. 节点 id 用脚本里真实出现过的 nodeId：`grep -oE "'n_[a-z0-9_]+'" <脚本源文件> | sort -u`；
3. 边按真实控制流连：启动基线 → 判据 → 动作、事件 → 分支动作，扇入/扇出照实画；
4. 类型和语义对齐：`ctx.after` = `delay`，阈值/模式判断 = `condition`，`ctx.write` 设备控制 = `action`，播报 = `announce` + label `播报：`；
5. 脚本里找不到依据的节点是假节点，删掉或补 `ctx.log(nodeId)`；
6. 脚本改版必须同步改 flow，随新版本一起提交；
7. 提交前自检：`node skill/tools/submit.cjs <id> <name> <src> <flow.json> --check`（只校验不提交）。

> **对话内需求流程图 ≠ 版本 flow.json**：SKILL.md 第 2 步在对话里共创的图是**需求设计稿**，回答"要画什么"（节点拆分、分支、旁路、阈值），不落盘、不提交；本节的版本 flow 回答"实际跑成什么"，仍按上面 7 条从定稿的 `script.js` 反推。设计稿确认后写脚本时 nodeId 必须沿用；实现中若需增删节点或改边，先回对话重新确认，再改脚本和版本 flow。

## 版本模型（先读这个再提交）

单向迭代：**提交/修改 → 影子（可原地反复改）→ publish → 正式（不可变）→ 被取代 → 归档**

| 通道 | 可改性 | 规则 |
|---|---|---|
| `shadow` | **可原地反复修改** | 至多 1 个。重新提交默认**覆盖当前影子**：版本号不变、`revision`+1；想另起候选版才 `newVersion:true`。改运行中的影子会先被停止 |
| `production` | **不可变** | 至多 1 个。publish 后内容锁定；要改只能提交新影子再发布。发布时若另一版本正在运行，服务端自动切换实例（停旧→影子启动新→热切正式；新版本起不来会回退旧版本） |
| `archive` | **不可变** | 分两类：`archivedKind=published`（曾上线，回滚候选）/ `discarded`（影子试错废弃）。只有归档版本可删除 |

- **实例并行**：同一脚本最多 1 个正式实例 + 1 个影子实例同时运行（互不影响：影子写操作被拦、ctx 上下文按 shadow/production 独立命名空间）；publish 后收敛为只剩一个正式实例；同槽位重复启动会被拒绝
- 版本号只在"发布后开新候选"或显式 `newVersion` 时递增，回滚也是新版本号（版本号只增不减）
- 回滚 = 读历史版本文档提交为**新影子版本**（`automation_rollback`），不自动上线，仍要走影子验证 → publish
- 三个版本概念必须分开表述：`latestVersion`（最新提交）/ `productionVersion`（线上）/ `runningVersion`（实例真正在跑），汇报时不得混用

## meta.json — 版本元信息

| 字段 | 含义 |
|---|---|
| `id` / `version` | 脚本标识与版本号（正整数，store 分配，只增不减） |
| `revision` | 该版本被原地修改的次数（1 = 只提交过一次；影子反复改时递增） |
| `name` / `description` | 展示名与版本说明（建议写清本版本改动） |
| `icon` | **新脚本首次提交必填**，迭代可省略（自动继承上一版）：脚本图标 SVG 源码字符串；列表/详情展示。绘制规范见下方 §icon |
| `sha256` | script.js 摘要，完整性校验（影子覆盖后会变） |
| `channel` | `shadow` / `production` / `archive`，**每通道至多 1 个版本** |
| `kind` | 业务种类，**同时决定运行模型**：`automation`=常驻自动化（默认，无一次性看门狗、由 start 管理）/ `script`=一次性动作脚本 / `scene`=场景（后两者跑完即退、有看门狗、可 trigger/ctx.call）。不传继承上一版，全新默认 `automation`。历史字段 `longRunning` 已退役，不再参与推断 |
| `runnerTimeoutMs` | 可选，脚本级运行超时覆盖（1000–86400000ms）：一次性脚本含长延时（如 30 分钟等待）时防全局 60s 看门狗误杀。迭代自动继承 |
| `restartable` | 可选，可重入触发：重复 trigger / ctx.call 时停旧启新（对齐 HA script mode:restart），默认 false（运行中重复触发拒绝）。迭代自动继承 |
| `hostMode` | 可选，脚本级宿主覆盖（fork/inprocess/worker 三值对称）：脱离默认策略单独指定宿主（2026-11-26 热池改造：正式一次性动作/场景未指定时自动走热池会话，常驻自动化跟随全局 EXECUTION_MODE）。跟随版本持久化、迭代自动继承；影子实例恒为专属 worker 不受影响 |
| `createdAt` / `updatedAt` | 时间戳（updatedAt=影子提交时间或发布时间；publishedAt 已退役） |

> 注意：meta.json **不存运行状态**（`status` 已退役）——运行状态由 executor 内存实时合成，只出现在 API 返回（`/api/scripts`、`/api/script/:id`、`/api/script/:id/versions`）；跨重启的真实运行意图看 `data/runtime/desired-running.json`。

## icon — 脚本图标（新脚本首次提交必填）

icon 是存进 meta.json 的 **SVG 源码字符串**（MCP 参数 `icon` / submit.cjs 参数 `--icon <icon.svg>`，本地源文件存 `icons/<scriptId>.svg`）。前端脚本列表左侧与详情页标题旁直接渲染。

**硬规则**（违反任一条会被服务端拒绝提交）：

1. 完整的单根 `<svg>…</svg>` 字符串，**≤ 8KB**；
2. `viewBox="0 0 64 64"`（等比缩放，前端按 20~22px 展示）；
3. 线条图形一律 `stroke="currentColor"` + `fill="none"`（实心点可用 `fill="currentColor"`），**禁止写死颜色**——`currentColor` 让图标随前端主题（亮/暗）与运行态（live 绿）自动着色；
4. **禁止** `<script>`、`<iframe>`、`<foreignObject>`、`<use>`、`<image>`、`on*` 事件属性、`javascript:`、`data:text/html`——服务端 `validIcon` 与前端 `safeIcon` 双重拦截；
5. 笔画粗细 `stroke-width="4"` 左右（20px 下仍清晰），圆角端点 `stroke-linecap="round"` + `stroke-linejoin="round"`。

**设计约定**：

- 一个脚本一个业务隐喻，一眼能认出管什么：热水器=水滴+波纹、大功率规避=闪电、厨房=锅+声波、倒计时=秒表、空调=机身+风叶波纹、夜灯=月牙+星、灯光场景=灯泡、守护=盾牌+对勾（参考 `examples/icons/`）；
- 元素 2~4 个为宜，宁简勿繁：图标最终只有 20px 大，细节多必糊；
- 主体居中占满画布（留 4~8px 边距），重心居中不偏头；
- 只有业务语义变化时才更新 icon（改了 icon 记得随版本重新提交）。

**模板**（起手直接抄，改中间图形即可）：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
  <!-- 业务隐喻图形：2~4 个元素，居中占满 -->
</svg>
```

## 相关数据文件

| 文件 | 说明 |
|---|---|
| `data/runtime/desired-running.json` | 运行意图清单 v2：`{ version: 2, entries: { "脚本id#v版本": { scriptId, version, startedAt } } }`——start 落盘、手动 stop 清除、shutdown 保留、服务重启按它恢复 |
| `data/context.json` | ctx.global / ctx.local 存储，按 `脚本id:通道` 与影子命名空间隔离 |
| `data/logs` | 结构化日志落盘（`scriptId / version / level / nodeId`） |
