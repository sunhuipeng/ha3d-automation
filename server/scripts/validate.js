'use strict';
/* 脚本静态校验：用 acorn 解析，禁止require/import/dynamic import/process/globalThis/eval/
 * Function/网络与文件 API。只放行纯逻辑 + ctx 白名单调用。
 * 注意：这是可控约束，不是强安全沙箱；配合独立子进程一起用。 */
const acorn = require('acorn');

const FORBIDDEN_NAMES = new Set([
  'require', 'process', 'globalThis', 'eval', 'Function',
  'module', 'exports', '__dirname', '__filename', 'Buffer',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts',
]);
const FORBIDDEN_MEMBER_ROOTS = new Set(['fs', 'net', 'http', 'https', 'child_process', 'os', 'path', 'vm', 'dns', 'tls']);
/* 原型/函数构造类成员：沙箱逃逸的核心链路（如 setTimeout.constructor('return process')()）。
 * 静态层先挡一道，运行层再切断宿主 realm 注入对象的原型链（见 runner.js）。 */
const FORBIDDEN_MEMBERS = new Set(['constructor', '__proto__', 'prototype', 'call', 'apply', 'bind']);

function validateScript(source) {
  let ast;
  try {
    ast = acorn.parse(String(source || ''), { ecmaVersion: 2022, sourceType: 'script', allowAwaitOutsideFunction: true });
  } catch (e) {
    return '语法错误：' + e.message;
  }
  const errors = [];
  function failName(name, node) {
    errors.push(`禁止标识符：${name}（第 ${node.loc ? node.loc.start.line : '?'} 行）`);
  }

  /* 无界同步循环检测：while(true) / for(;;) 等恒真循环，且循环体内没有任何 await 让出
   * → inline 单进程模式下会永久阻塞其他所有脚本，静态层直接拒绝。
   * 含 await 的长驻循环合法（异步让出），不拦截。 */
  function subtreeHasYield(node) {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'AwaitExpression' || node.type === 'YieldExpression') return true;
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      if (subtreeHasYield(node[key])) return true;
    }
    return false;
  }
  function isAlwaysTrueTest(t) {
    if (t === null || t === undefined) return true;              // for(;;)
    if (t.type === 'Literal') return !!t.value;                  // true / 1 / 非空串
    if (t.type === 'Identifier' && t.name === 'true') return true;
    return false;
  }

  function walk(node, parent) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const c of node) walk(c, parent); return; }
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
      errors.push('禁止 import / export 语句');
    }
    if (node.type === 'ImportExpression') errors.push('禁止动态 import()');
    if ((node.type === 'WhileStatement' || node.type === 'DoWhileStatement' || node.type === 'ForStatement')
      && isAlwaysTrueTest(node.test) && !subtreeHasYield(node.body)) {
      errors.push(`禁止无界同步循环（第 ${node.loc ? node.loc.start.line : '?'} 行）：会让出前永久阻塞其他脚本；长驻等待用 await ctx.keepAlive()，周期用 ctx.every，延时用 ctx.after / await ctx.sleep`);
    }
    if (node.type === 'Identifier') {
      if (FORBIDDEN_NAMES.has(node.name)) failName(node.name, node);
      // L8：用 node.name 显式判定 ctx.global 例外，不再用 parent.property === node 的对象身份比较
      if (node.name === 'global') {
        const isCtxGlobal = parent && parent.type === 'MemberExpression' && parent.property === node
          && parent.object && parent.object.type === 'Identifier' && parent.object.name === 'ctx';
        if (!isCtxGlobal) failName('global', node);
      }
      /* .call 是 Function.prototype 逃逸链成员，但 ctx.call 是框架开放的脚本间调用 API，
       * 仅放行"ctx.call"这一个形状（computed ctx['call'] 的 property 是 Literal，不走这里）。 */
      const isCtxCallProperty = node.name === 'call' && parent && parent.type === 'MemberExpression'
        && parent.property === node && parent.object && parent.object.type === 'Identifier'
        && parent.object.name === 'ctx';
      if (FORBIDDEN_MEMBERS.has(node.name) && !isCtxCallProperty) failName(node.name, node);
    }
    if (node.type === 'MemberExpression') {
      // 模块根访问（fs.xxx 等）
      if (!node.computed && node.object && node.object.type === 'Identifier' && FORBIDDEN_MEMBER_ROOTS.has(node.object.name)) {
        errors.push(`禁止访问模块：${node.object.name}（第 ${node.loc ? node.loc.start.line : '?'} 行）`);
      }
      // S2：任何 .constructor / .__proto__ / .prototype / .call/.apply/.bind 成员访问都拒绝，
      // 包括计算成员 obj['constructor']（字符串字面量可静态判定）。
      let memberName = null;
      if (!node.computed && node.property && node.property.type === 'Identifier') memberName = node.property.name;
      else if (node.computed && node.property && node.property.type === 'Literal' && typeof node.property.value === 'string') memberName = node.property.value;
      /* ctx.call 例外：仅 ctx 直接下属；ctx.a.call(...) 这类借道 Function.prototype 仍拒绝。 */
      const isCtxCall = memberName === 'call' && node.object && node.object.type === 'Identifier'
        && node.object.name === 'ctx';
      if (memberName && FORBIDDEN_MEMBERS.has(memberName) && !isCtxCall) {
        errors.push(`禁止成员访问：.${memberName}（第 ${node.loc ? node.loc.start.line : '?'} 行）`);
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'parent') continue;
      walk(node[key], node);
    }
  }
  walk(ast, null);
  return errors.length ? errors.slice(0, 10).join('；') : null;
}

module.exports = { validateScript };
