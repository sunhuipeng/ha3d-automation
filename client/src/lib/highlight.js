/* 轻量 JS 语法着色：注释 / 字符串 / 数字 / 关键字 / 内建对象 / 运算符。
 * 从 ScriptViewer 抽出，供源码预览与 diff 双栏共用（不引入 Monaco 重依赖）。
 * 所有文本先 escapeHtml，输出可直接 v-html。 */
const KEYWORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'finally', 'for', 'from', 'function', 'if', 'import',
  'in', 'instanceof', 'let', 'new', 'of', 'return', 'static', 'super', 'switch', 'this',
  'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'async', 'true',
  'false', 'null', 'undefined', 'NaN', 'Infinity',
]);
const BUILTINS = new Set(['ctx', 'console', 'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Date', 'Promise', 'setTimeout', 'setInterval']);

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const TOKEN_RE = /(\/\*.*?\*\/|\/\/.*$)|(`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)\b|(=>|===|!==|==|!=|<=|>=|&&|\|\||\+\+|--|[{}()[\].,;:+\-*/%<>!?=])/g;

export function highlight(line) {
  let out = '';
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(line)) !== null) {
    out += escapeHtml(line.slice(last, m.index));
    if (m[1]) out += `<span class="tok-comment">${escapeHtml(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-string">${escapeHtml(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-number">${escapeHtml(m[3])}</span>`;
    else if (m[4]) {
      const cls = KEYWORDS.has(m[4]) ? 'tok-keyword' : (BUILTINS.has(m[4]) ? 'tok-builtin' : 'tok-ident');
      out += `<span class="${cls}">${escapeHtml(m[4])}</span>`;
    } else if (m[5]) out += `<span class="tok-op">${escapeHtml(m[5])}</span>`;
    last = TOKEN_RE.lastIndex;
  }
  out += escapeHtml(line.slice(last));
  return out || '&nbsp;';
}
