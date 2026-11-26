'use strict';
/* 配置：data/config.json（gitignore）+ 环境变量覆盖。
 * HA token 只存在于服务端，绝不下发浏览器 / MCP 输出。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
/* 数据目录：默认 <项目>/data；容器里用 HA3D_AUTOMATION_DATA_DIR=/data 指向挂载卷，
 * 脚本版本 / 上下文 / 运行日志 / HA 连接配置升级镜像不丢（与 studio 的 HA3D_STUDIO_DATA_DIR 同款约定）。 */
const DATA = path.resolve(process.env.HA3D_AUTOMATION_DATA_DIR || path.join(ROOT, 'data'));
const CONFIG_FILE = path.join(DATA, 'config.json');
/* 仿真用例目录：直接落在 skill/.fixtures（跟着 skill 走——可直接复用、随 skill.zip 打包，
 * 不再有"服务端副本"这一层）。测试/容器可用 HA3D_AUTOMATION_FIXTURE_DIR 覆盖。 */
const FIXTURES = path.resolve(process.env.HA3D_AUTOMATION_FIXTURE_DIR || path.join(ROOT, 'skill', '.fixtures'));

const DEFAULTS = {
  port: 8100,
  haUrl: '',
  token: '',
  // 脚本执行约束
  runnerTimeoutMs: 60000,
  actionCooldownMs: 300,
  maxRestarts: 3,
  // MCP 直调 HA 服务：默认关闭，需要时再显式开启（契约 §7）
  allowMcpCallService: false,
  // 脚本执行方式：fork = 每脚本一个子进程（默认，进程级隔离最硬）；
  // inprocess = 全部脚本在主进程内 vm 执行（最省内存，回调有 vm timeout 防死循环兜底）；
  // worker = 每脚本一个 worker 线程（OS 抢占式公平调度 + terminate 强杀，内存居中）
  executionMode: 'fork',
};

let cached = null;

function readFileConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

const EXECUTION_MODES = ['fork', 'inprocess', 'worker'];

/* 全局开发模式：HA3D_DEV_MODE=true（仅环境变量，刻意不进 config.json / saveConfig 白名单，
 * 防止随数据目录拷贝漂移到正式环境）。生效后：脚本发起的所有 HA 写（含正式实例）只记日志
 * 不下发；instance 通道身份不变（正式仍是正式）、上下文写正式桶、正式实例可自动恢复、
 * 影子可发布。MCP 直调 HA 不受此开关约束（用户显式 confirmed 调用）。 */
const DEV_MODE = /^(1|true|yes|on)$/i.test(String(process.env.HA3D_DEV_MODE || ''));

function getConfig() {
  if (cached) return cached;
  const file = readFileConfig();
  const env = process.env;
  const modeRaw = String(env.EXECUTION_MODE || file.executionMode || DEFAULTS.executionMode);
  cached = {
    ...DEFAULTS,
    ...file,
    port: Number(env.PORT || file.port || DEFAULTS.port),
    haUrl: String(env.HA_URL || file.haUrl || ''),
    token: String(env.HA_TOKEN || file.token || ''),
    runnerTimeoutMs: Number(env.RUNNER_TIMEOUT_MS || file.runnerTimeoutMs || DEFAULTS.runnerTimeoutMs),
    actionCooldownMs: Number(env.ACTION_COOLDOWN_MS || file.actionCooldownMs || DEFAULTS.actionCooldownMs),
    maxRestarts: Number(env.MAX_RESTARTS || file.maxRestarts || DEFAULTS.maxRestarts),
    allowMcpCallService: env.ALLOW_MCP_CALL_SERVICE != null
      ? /^(1|true|yes|on)$/i.test(env.ALLOW_MCP_CALL_SERVICE)
      : (file.allowMcpCallService === true),
    executionMode: EXECUTION_MODES.includes(modeRaw) ? modeRaw : DEFAULTS.executionMode,
    devMode: DEV_MODE,
  };
  return cached;
}

function resetConfigCache() { cached = null; }

/* 写回 data/config.json：只收白名单字段；value 为 undefined 的键不动。
 * token 传空字符串 = 保留原值（浏览器只拿到脱敏值，不能回传原文）。 */
const WRITABLE_KEYS = ['haUrl', 'token', 'runnerTimeoutMs', 'actionCooldownMs', 'maxRestarts', 'allowMcpCallService', 'executionMode'];

function saveConfig(patch) {
  const file = readFileConfig();
  const next = { ...file };
  for (const key of WRITABLE_KEYS) {
    if (!(key in patch)) continue;
    let v = patch[key];
    if (key === 'token' && (v === '' || v == null)) continue;
    if (['runnerTimeoutMs', 'actionCooldownMs', 'maxRestarts'].includes(key)) v = Number(v);
    if (key === 'haUrl') v = String(v || '').trim();
    if (key === 'allowMcpCallService') v = v === true || v === 'true' || v === '1' || v === 1;
    next[key] = v;
  }
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  resetConfigCache();
  return publicConfig();
}

/* 给前端看的配置：token 永不下发，只报是否已配置 */
function publicConfig() {
  const c = getConfig();
  return {
    haUrl: c.haUrl,
    hasToken: !!c.token,
    runnerTimeoutMs: c.runnerTimeoutMs,
    actionCooldownMs: c.actionCooldownMs,
    maxRestarts: c.maxRestarts,
    allowMcpCallService: c.allowMcpCallService,
    devMode: DEV_MODE,
  };
}

function ensureDataDir() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(path.join(DATA, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(DATA, 'runtime'), { recursive: true });
}

module.exports = { ROOT, DATA, FIXTURES, DEV_MODE, getConfig, ensureDataDir, saveConfig, publicConfig };
