'use strict';
/* 脚本版本 diff（服务端统一计算，前端只渲染）：
 * 用 diff 库的 Myers 算法（diffLines），避免手写 LCS 在长脚本上 O(n×m) 卡顿。
 * 行号语义：删除行只有 oldNo，新增行只有 newNo，上下文行两者都有。
 * 上下文压缩：仅保留变更行前后 context 行，中间跳过段用 {type:'gap', count} 表示。 */
const { diffLines, diffChars } = require('diff');

function norm(src) {
  return String(src == null ? '' : src).replace(/\r\n?/g, '\n');
}

function computeDiff(oldSrc, newSrc, context = 3) {
  const parts = diffLines(norm(oldSrc), norm(newSrc));
  const rows = [];
  let oldNo = 1;
  let newNo = 1;
  for (const part of parts) {
    const lines = part.value.split('\n');
    if (lines[lines.length - 1] === '') lines.pop(); // 末尾换行不产生空行
    for (const text of lines) {
      const type = part.added ? 'add' : part.removed ? 'del' : 'ctx';
      rows.push({
        type,
        text,
        oldNo: type === 'add' ? null : oldNo++,
        newNo: type === 'del' ? null : newNo++,
      });
    }
  }

  const added = rows.filter((r) => r.type === 'add').length;
  const removed = rows.filter((r) => r.type === 'del').length;
  const keep = new Set();
  rows.forEach((r, i) => {
    if (r.type === 'ctx') return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep.add(j);
  });
  const compact = [];
  for (let i = 0; i < rows.length; i++) {
    if (keep.has(i)) { compact.push(rows[i]); continue; }
    /* 连续跳过行合并成一个 gap（count = 省略行数），不能按"上一行是否保留"判断 */
    if (compact.length && compact[compact.length - 1].type === 'gap') compact[compact.length - 1].count++;
    else compact.push({ type: 'gap', count: 1 });
  }
  /* 并排对齐：连续 del/add 块配对成同一水平行（多出的落单侧留空）。
   * 上下文行左右都有内容；gap 横跨两栏。成对变更额外算字符级 inline 段，
   * 让前端能像 VSCode 那样只高亮行内真正改动的部分。 */
  function inlineSegs(a, b) {
    const left = [];
    const right = [];
    for (const p of diffChars(a, b)) {
      if (p.added) right.push({ text: p.value, changed: true });
      else if (p.removed) left.push({ text: p.value, changed: true });
      else { left.push({ text: p.value, changed: false }); right.push({ text: p.value, changed: false }); }
    }
    return { left, right };
  }

  function toSide(source) {
    const out = [];
    for (let i = 0; i < source.length;) {
      const row = source[i];
      if (row.type === 'ctx') {
        out.push({ kind: 'ctx', left: { no: row.oldNo, text: row.text }, right: { no: row.newNo, text: row.text } });
        i++;
        continue;
      }
      if (row.type === 'gap') { out.push({ kind: 'gap', count: row.count }); i++; continue; }

      /* 收集连续的变更块（del / add 交错）后配对 */
      const dels = [];
      const adds = [];
      while (i < source.length && source[i].type !== 'ctx' && source[i].type !== 'gap') {
        (source[i].type === 'del' ? dels : adds).push(source[i]);
        i++;
      }
      const n = Math.max(dels.length, adds.length);
      for (let j = 0; j < n; j++) {
        const l = dels[j] || null;
        const rr = adds[j] || null;
        const pair = {
          kind: l && rr ? 'change' : (l ? 'del' : 'add'),
          left: l ? { no: l.oldNo, text: l.text } : null,
          right: rr ? { no: rr.newNo, text: rr.text } : null,
        };
        if (l && rr) pair.inline = inlineSegs(l.text, rr.text);
        out.push(pair);
      }
    }
    return out;
  }

  /* rows/allRows = 单栏统一视图（折叠/完整）；sideRows/allSideRows = 并排视图，同源一次返回 */
  return {
    changed: added > 0 || removed > 0,
    added, removed,
    rows: compact, allRows: rows,
    sideRows: toSide(compact), allSideRows: toSide(rows),
  };
}

module.exports = { computeDiff };
