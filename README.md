# ha3d-automation

本地托管的 HA（Home Assistant）自动化执行平台：把 HA 里的自动化迁移为可版本管理、可影子验证、可兜底恢复的**脚本**，由服务端统一托管执行；HA 连接器 + MCP 工具 + 脚本执行器 + 只读流程画布（画布只做展示、不可编辑，执行真相是脚本）。

## 能力一览

- **脚本托管**：三种执行模式（`EXECUTION_MODE`：`fork` 每脚本独立子进程 / `inprocess` 单进程 vm 执行省内存 / `worker` 每脚本一个线程，OS 抢占式调度 + 强杀）；**影子脚本强制 fork**——未验证代码独享子进程硬隔离，失控只影响自己，正式脚本才按 `EXECUTION_MODE` 走省资源宿主；realm 沙箱 + AST 静态校验（含无界同步循环拦截），版本仓库、影子/正式双通道灰度
- **MCP 接入**：24 个工具（15 只读 + 7 受控写 + 2 面板控制），SSE 端点供 Agent 直接读写脚本与 HA 实体
- **兜底体系**：服务重启按运行意图清单自动恢复；HA 断线挂起写操作、重连自动继续；引用实体被删自动暂停、恢复后自动继续
- **前端面板**：Vue 3 可视化管理脚本、版本、日志与运行状态

## 技术栈

- 服务端：Node.js + Express + `ws` + `@modelcontextprotocol/sdk`（SSE）
- 前端：Vue 3 + Pinia + Vite
- 持久化：JSON 文件（`data/scripts/<id>/v<n>/`），不引数据库

## 快速开始

```bash
npm install
npm run client:build        # 构建前端到 client/dist
npm start                   # http://localhost:8100
```

开发模式：终端 A `npm start`，终端 B `npm run client:dev`（Vite 5176，代理到 8100）。

### 启动方式对比

| 命令 | 用途 | 写操作（控制真实设备） | 适用场景 |
|---|---|---|---|
| `npm start` | 完整功能实例 | ✅ 正常下发 | **正式环境**（NAS Docker 部署即此形态，不加任何 DEV 环境变量） |
| `npm run start:dev` | **全局开发模式**实例 | ❌ 全部拦截只记日志 | **本地开发**：家里正式 HA 已由 NAS 实例托管，本地再起一份会双份裁决抢设备，必须用这个 |
| `npm run watch` | 服务端代码热重启（`node --watch`） | ✅ 同 `npm start` | 改 `server/` 源码时的开发辅助；正式 HA 已在线上托管时同样建议配合 `HA3D_DEV_MODE=true` 用 |
| `npm run client:dev` | 前端 Vite 热更新（5176，代理 8100） | —（不跑服务端） | 改 `client/` 前端源码时与上面任一服务端命令配合使用 |

**全局开发模式（`npm run start:dev`，即 `HA3D_DEV_MODE=true`）与 `npm start` 的行为差异**：

1. **恢复不过滤**：进程启动按运行意图清单恢复时，正式实例也照常恢复——但实例保持真实通道身份，**设备写被 devMode 闸拦截**只记日志不下发，本地启动不会真正控制设备；
2. **写全拦截**：手动启动（含正式版本）实例身份不变（正式就是正式），所有 HA 写调用经 devMode 闸只记日志不下发，启动日志有「开发模式」标注；读操作照常，能用真实数据调试；
3. **publish 允许**：发布正常执行（通道切为正式、实例可恢复），设备写仍被 devMode 闸拦住——本地可以走完整「提交影子 → 发布」流程验证；
4. **UI 横幅**：面板 header 下方显示警示横幅，防止误以为本地面板在控制设备。

配置（HA 地址 / token / 超时参数，支持环境变量覆盖 `PORT` / `HA_URL` / `HA_TOKEN` / `RUNNER_TIMEOUT_MS` / `ACTION_COOLDOWN_MS` / `MAX_RESTARTS` / `ALLOW_MCP_CALL_SERVICE` / `EXECUTION_MODE`）写在 `data/config.json`（已 gitignore）；未配置 token 时进入 demo 模式，链路仍可跑通。HA token 只在服务端，绝不下发前端 / MCP 输出。

`EXECUTION_MODE`：`fork`（默认，每脚本一个子进程，进程级隔离最硬）、`inprocess`（全部脚本在主进程内 vm 执行，最省内存；脚本回调有 V8 timeout 防同步死循环）或 `worker`（每脚本一个 worker 线程，OS 抢占式公平调度 + `terminate()` 可强杀 vm timeout 拦不住的异步续体，内存居中）。三种模式脚本与数据完全兼容，改配置重启即切换。选型口诀：信脚本用 `inprocess`，不信用 `fork`，省内存又要隔离用 `worker`。

**脚本级宿主覆盖**：提交时传 `hostMode`（submit_script 参数 / submit.cjs `--host-mode=`），可让个别脚本脱离全局模式单独指定宿主（三值对称：全局 inprocess 时给重脚本覆盖 `fork` 独享子进程，全局 fork 时给轻脚本覆盖 `inprocess` 省内存）。跟随版本持久化、影子迭代自动继承；影子实例恒为 fork 不受覆盖影响。优先级：影子强制 fork > 脚本级 `hostMode` > 全局 `EXECUTION_MODE`。发布迁移：目标宿主为 fork 时同宿主热切换零中断，否则 stop+start 重建到目标宿主。

## MCP 接入

SSE 地址：`http://localhost:8100/mcp/sse`（24 个工具：15 只读 + 7 受控写 + 2 面板控制，写操作需 `confirmed: true`，其中 `automation_call_service` 默认关闭，需开启 `allowMcpCallService`）。工具清单与调用示例见 [skill/SKILL.md](skill/SKILL.md) 与 `skill/tools/mcp-call.cjs`。

## 文档

**开发文档统一在 [skill/](skill/SKILL.md) 维护**（ctx 接口参考、脚本编写规范、版本文件规范、脚本骨架模板、开发流程）：

| 文档 | 内容 |
|---|---|
| [skill/SKILL.md](skill/SKILL.md) | 脚本开发流程与硬规则（可直接导入 AI Agent） |
| [skill/references/ctx-api.md](skill/references/ctx-api.md) | ctx 接口与参数完整参考 |
| [skill/references/file-specs.md](skill/references/file-specs.md) | script.js / flow.json / meta.json 规范 |
| [skill/tools/](skill/tools/) | 服务操作工具（mcp-call.cjs 通用 MCP 调用器 / submit.cjs 提交并校验 flow / sync-cache.cjs 同步本地脚本缓存） |
| `skill/.cache/` | 本地脚本镜像（`sync-cache.cjs` 生成，服务端最新版的只读副本 + `_index.md` 实体索引，已 gitignore） |
| [ENTITY-MAP.md](ENTITY-MAP.md) | 实体映射核对表（脚本 ↔ HA 实体） |
| [MIGRATION-ANALYSIS-2026-11-24.md](MIGRATION-ANALYSIS-2026-11-24.md) | HA 原生自动化迁移分析（18 条 → 8 脚本） |

## 测试

```bash
npm test                    # node:test，全部通过（含影子隔离 / 三执行模式 / 开发模式等集成测试）
```
