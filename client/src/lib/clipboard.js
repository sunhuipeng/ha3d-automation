/* 剪贴板写入：navigator.clipboard 不可用时（局域网 IP + http）退化为 execCommand 兜底。
 * 返回是否真的成功，调用方据此提示，不静默报「已复制」。（同源 studio lib/clipboard.js） */
export async function copyText(text) {
  const value = String(text == null ? '' : text);
  if (!value) return false;
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (e) { /* 落 execCommand 兜底 */ }
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = !!document.execCommand('copy'); } catch (e) {}
  ta.remove();
  return ok;
}
