# ha3d-automation — HA 连接器 + MCP 工具 + 脚本执行器 + 只读流程预览
#
# 多阶段构建：
#   Stage 1  用 devDependencies（Vite）把 Vue 前端构建成 client/dist（js / css / html 已 minify）
#   Stage 2  只带 生产依赖 + 服务端源码（原样，方便进容器排查）+ 构建好的前端，
#            数据全部走挂载卷 /data（脚本版本、上下文、运行日志、HA 连接配置），升级镜像不丢
#
# 服务端**不做压缩**：镜像里保持 server/ 可读源码，报错栈行号与仓库一一对应。
#
# 运行配置（与 ha3d-plugin-studio 同款环境变量约定）：
#   PORT                       监听端口，默认 8100
#   HA3D_AUTOMATION_DATA_DIR   数据目录，容器内指向挂载点 /data
#   HA_URL / HA_TOKEN          HA 连接信息（也可以放挂载卷的 data/config.json）

# ---------- Stage 1: 构建前端 ----------
FROM node:22-alpine AS client-build
WORKDIR /build

# 本阶段不装任何 apk 包（打 zip 用 scripts/pack-skill.cjs + Node 内置 zlib），
# 因此也没有 apk 源/镜像源配置——构建过程完全不需要访问 Alpine 仓库。
COPY client/package.json client/package-lock.json ./client/
RUN npm --prefix client ci --no-audit --no-fund

COPY client ./client
# Vite 构建本身就带 minify
RUN npm --prefix client run build

# skill 压缩包：前端弹层"下载 skill 压缩包"直接取走给 Agent 安装。
# 用 Node 脚本打包（scripts/pack-skill.cjs，只依赖内置 zlib），不装 zip、不联网。
# 打包器单独 COPY 且放在 skill 之前：skill 每次变动只重跑最后这条秒级命令。
COPY scripts/pack-skill.cjs ./pack-skill.cjs
COPY skill ./skill
RUN node pack-skill.cjs skill /build/skill.zip

# ---------- Stage 2: 运行层 ----------
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8100 \
    HA3D_AUTOMATION_DATA_DIR=/data \
    TZ=Asia/Shanghai

# 服务端生产依赖（package-lock 锁版本）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# 服务端源码（原样，不压缩）+ Stage 1 构建好的前端
COPY server ./server
COPY --from=client-build /build/client/dist ./client/dist

# skill 压缩包：/api/skill-package 下载路由读取（不存在时返回失败提示）
COPY --from=client-build /build/skill.zip /app/skill.zip

RUN mkdir -p /data

VOLUME ["/data"]
EXPOSE 8100

CMD ["node", "server/index.js"]
