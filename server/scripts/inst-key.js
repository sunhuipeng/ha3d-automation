'use strict';
/* 实例键的唯一实现：executor 的 running 表与 run-state 的持久化清单共用同一格式。
 * 历史上两处各自拼 `${sid}#v${version}`，任何一侧改动都会静默破坏重启恢复链。 */

function instKey(sid, version) { return `${sid}#v${Number(version)}`; }

/* 反解：restore 兼容 v1 清单（键即 sid）与新清单（键 = sid#vN） */
function parseKey(key) {
  const s = String(key || '');
  const i = s.indexOf('#v');
  if (i < 0) return { sid: s, version: null };
  const version = Number(s.slice(i + 2));
  return { sid: s.slice(0, i), version: Number.isInteger(version) ? version : null };
}

/* 脚本 id 校验的唯一实现（审计 P1：此前 store/run-state/context 三处复制同一正则，
 * 口径变更漏改一侧即产生安全/一致性缺口）。本模块零依赖，store/run-state/context
 * 都从这里引用，避免 store→context→store 循环 require。合法时返回规范化 id，否则 null。 */
function safeId(id) {
  const s = String(id || '');
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
}

module.exports = { instKey, parseKey, safeId };
