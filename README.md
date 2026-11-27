# ha3d-automation

本地托管的 HA（Home Assistant）自动化执行平台：把 HA 里的自动化迁移为可版本管理、可影子验证、可兜底恢复的**脚本**，由服务端统一托管执行；HA 连接器 + MCP 工具 + 脚本执行器 + 只读流程画布（画布只做展示、不可编辑，执行真相是脚本）。

## 能力一览

- **脚本托管**：三种执行模式（`EXECUTION_MODE`：`fork` 每脚本独立子进程 / `inprocess` 单进程 vm 执行省内存 / `worker` 每脚本一个线程，OS 抢占式调度 + 强杀）；**影子脚本强制独立 worker**（每次新建、用完即毁）——未验证代码独享 worker 线程隔离，失控只影响自己，正式脚本才按 `EXECUTION_MODE` 走省资源宿主；realm 沙箱 + AST 静态校验（含无界同步循环拦截），版本仓库、影子/正式双通道灰度
- **MCP 接入**：25 个工具（15 只读 + 8 受控写 + 2 面板控制），SSE 端点供 Agent 直接读写脚本与 HA 实体
- **兜底体系**：服务重启按运行意图清单自动恢复；HA 断线挂起写操作、重连自动继续；引用实体被删自动暂停、恢复后自动继续
- **前端面板**：Vue 3 可视化管理脚本、版本、日志与运行状态

## 技术栈

- 服务端：Node.js + Express + `ws` + `@modelcontextprotocol/sdk`（SSE）
- 前端：Vue 3 + Pinia + Vite
- 持久化：JSON 文件（`data/scripts/<id>/v<n>/`），不引数据库

## 解决什么痛点

**1. HA 原生自动化 / 脚本写不了复杂逻辑**

HA 的自动化和脚本靠 YAML 配置表达，逻辑一旦复杂（多条件裁决、跨设备联动、滑动窗口防抖、异常兜底、脚本间依赖）就力不从心——通常被迫拆成多个子自动化互相配合，靠 `input_boolean` 等辅助实体在中间传状态：状态散落在各处、触发时序难保证、谁也说不清某个时刻整个系统处于什么状态，改一处要逐个检查所有相关自动化。

本项目把复杂逻辑收敛为**一个 JavaScript 脚本**：`ctx` 框架内置状态机、持续确认（`ctx.hold`）、防抖/冷却、跨脚本依赖（`ctx.task.*`）与上下文存储（`ctx.global/local`），复杂裁决写在一处、一个脚本一个职责，改动即新版本。

**2. Node-RED 逐个拖节点，接线复杂、维护成本高**

Node-RED 用拖拽连线表达自动化：节点即逻辑、连线即流程。逻辑一复杂，画布上几十个节点互相缠绕，改需求要顺着线捋半天；连线数据是私有格式，没有版本 diff、难做代码复用、更难做自动回归；`function` 节点里的代码同样游离在版本管理之外。

本项目**去掉"画布即逻辑"**：执行真相是带版本号的脚本源码，`flow.json` 只是从脚本反推的只读投影（前端画布可视化用）。改逻辑 = 改代码 + 升版本，git 友好、可 diff、可复用、可测试（`npm test` 全量回归）。

## 核心亮点：三模式验证链

每个脚本从开发到上线走一条固定的验证链，**先快后真、设备零风险**：

| 模式 | 干什么 | 关键特性 |
|---|---|---|
| **仿真 simulate** | **秒级验证逻辑正确性**：在虚拟世界里跑（虚拟实体表 + 虚拟时钟），时钟快进、实体注入、逐条断言写意图 | 不碰任何真实设备；一次 `advance` 快进 30 秒，几分钟跑完整套回归用例；断言失败直接给出 expected/actual |
| **影子 shadow** | **跟随日常家居真实验证**：挂在真实 HA 上照常监听实体变动、做真实裁决，**写操作只记日志不下发** | 验证期不干扰任何设备；真实环境、真实数据、真实时序下看日志反馈，确认逻辑在实战里也正确 |
| **正式 production** | **线上正常使用**：写操作真实下发控制设备 | 只有影子验证通过、**用户显式确认后**才允许发布；发布前后版本共存可回滚 |

固定顺序：**仿真（验流程/时序/写意图）→ 影子（真实环境验日志）→ 发布正式（接管设备）**。顺序不能倒、不能跳；写错一个阈值，最坏结果只是影子日志里多一行错误记录，而不是家里灯乱闪。

配套兜底：服务重启按运行意图清单自动恢复；HA 断线自动挂起写操作、重连续跑；引用实体被删自动暂停、恢复后自动继续。



## 快速开始

```bash
npm install
npm --prefix client run build   # 构建前端到 client/dist
npm start                   # http://localhost:8100
```

开发模式：终端 A `npm start`，终端 B `npm --prefix client run dev`（Vite 5176，代理到 8100）。

### Docker 部署 / 公开镜像

公开镜像仓库：<https://cnb.cool/sunhuipeng/ha3d-images>（打开后点顶部「**制品**」查看全部镜像与 tag）。公开仓库无需登录即可拉取，镜像为 **amd64 + arm64** 多架构：

```bash
docker pull docker.cnb.cool/sunhuipeng/ha3d-images/ha3d-automation:latest
```

用公开镜像部署：删掉 `docker-compose.yml` 里的 `build: .`，把 `image:` 改成 `docker.cnb.cool/sunhuipeng/ha3d-images/ha3d-automation:latest`，再 `docker compose up -d`（首次自动拉取；更新用 `docker compose pull && docker compose up -d`）。端口 `8100`、数据卷 `./data`（脚本版本 / 上下文 / 日志 / HA 连接配置）、`/etc/localtime` 时区挂载与 `EXECUTION_MODE` 等环境变量沿用自带 compose，升级镜像不丢数据。

### 启动方式对比

| 命令 | 用途 | 写操作（控制真实设备） | 适用场景 |
|---|---|---|---|
| `npm start` | 完整功能实例 | ✅ 正常下发 | **正式环境**（NAS Docker 部署即此形态，不加任何 DEV 环境变量） |
| `npm run start:dev` | **全局开发模式**实例 | ❌ 全部拦截只记日志 | **本地开发**：家里正式 HA 已由 NAS 实例托管，本地再起一份会双份裁决抢设备，必须用这个 |
| `npm run watch` | 服务端代码热重启（`node --watch`） | ✅ 同 `npm start` | 改 `server/` 源码时的开发辅助；正式 HA 已在线上托管时同样建议配合 `HA3D_DEV_MODE=true` 用 |
| `npm --prefix client run dev` | 前端 Vite 热更新（5176，代理 8100） | —（不跑服务端） | 改 `client/` 前端源码时与上面任一服务端命令配合使用 |


## MCP 接入

SSE 地址：`http://localhost:8100/mcp/sse`（25 个工具：15 只读 + 8 受控写 + 2 面板控制，写操作需 `confirmed: true`，其中 `automation_call_service` 默认关闭，需开启 `allowMcpCallService`）。工具清单与调用示例见 [skill/SKILL.md](skill/SKILL.md) 与 `skill/tools/mcp-call.cjs`。

## 开放 HTTP 接口（跨项目联动）

除 MCP 外，服务端还暴露两个最小只读/触发面 HTTP 接口，供外部平台（当前消费方：[ha-3d-home](../ha-3d-home) 通过 `server/automation-proxy.js` 代理）联动本项目的脚本能力。**任何平台都可以直接调用**，无需鉴权（默认只监听内网，请勿裸暴露公网）：

### GET /api/actions — 动作与场景候选列表（只读）

列出可被外部展示/勾选的一次性脚本与场景（`kind=script/scene`，不含长驻 automation），含影子候选（本地开发迁移项多为影子，便于先配好展示项）。不返回脚本正文、运行实例等管理信息，是跨项目的最小只读面。

```jsonc
// 响应
{
  "items": [
    {
      "id": "goodnight-scene",
      "name": "晚安模式",
      "kind": "scene",
      "description": "关闭全部灯光并锁门",
      "icon": "<svg ...>...</svg>",   // 与 svg 字段同源双写
      "svg": "<svg ...>...</svg>",
      "productionVersion": 3,          // 无正式版为 null
      "shadowVersion": 5,              // 无影子版为 null
      "triggerable": true              // 是否有正式版（触发接口只认正式版）
    }
  ]
}
```

### POST /api/script/:id/trigger — 一次性触发执行

触发指定脚本立即执行一次。缺省只认**正式版本**；`body.channel = "shadow"` 可触发影子版本（写操作被执行器硬拦截只记日志，不改 HA 实体）。只认短脚本（非长驻），长脚本返回 400。

```jsonc
// 请求体（可选）
{ "channel": "shadow" }

// 成功响应
{ "ok": true, "id": "goodnight-scene", "version": 3, "mode": "production", "devMode": false }

// 失败响应（400）
{ "error": "脚本 id 非法" }
```

### 调用注意

- **无需鉴权**：接口设计为内网互信；生产部署请通过防火墙/反代限制来源，或置于有鉴权的网关之后。
- **错误口径**：失败统一 `{ "error": "消息" }`，HTTP 状态 400（参数/脚本问题）或 5xx（服务内部问题）。
- **设备写安全链不变**：trigger 触发的执行与其他入口完全同源——影子通道写操作硬拦截，dev 模式下设备写另由 devMode 闸拦截，外部平台无法绕过三模式验证链。
- **Home 项目的代理方式参考**：ha-3d-home 不直连本服务，而是服务端代理（`/api/automation/actions` → `/api/actions`，`/api/automation/trigger/:id` → `/api/script/:id/trigger`），上游地址由 `HA3D_AUTOMATION_URL` 配置（默认 `http://127.0.0.1:8100`），内网地址不出服务端。其他平台可按需同样代理或直连。

## 文档

**开发文档统一在 [skill/](skill/SKILL.md) 维护**（ctx 接口参考、脚本编写规范、版本文件规范、脚本骨架模板、开发流程）：

| 文档 | 内容 |
|---|---|
| [skill/SKILL.md](skill/SKILL.md) | 脚本开发流程与硬规则（可直接导入 AI Agent） |
| [skill/references/ctx-api.md](skill/references/ctx-api.md) | ctx 接口与参数完整参考 |
| [skill/references/file-specs.md](skill/references/file-specs.md) | script.js / flow.json / meta.json 规范 |
| [skill/tools/](skill/tools/) | 服务操作工具（mcp-call.cjs 通用 MCP 调用器 / submit.cjs 提交并校验 flow / sync-cache.cjs 同步本地脚本缓存） |

## 测试

```bash
npm test                    # node:test，全部通过（含影子隔离 / 三执行模式 / 开发模式等集成测试）
```
