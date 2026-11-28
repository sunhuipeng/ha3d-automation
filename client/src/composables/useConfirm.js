import { ref } from 'vue';
/* 自定义确认弹窗（审计 3.2 从 App.vue 抽出）：模块级单例，替代 window.confirm。
 * askConfirm 返回 Promise，true=确定 false=取消；同一时刻只允许一个弹窗。 */
const dialog = ref({ open: false, title: '', message: '', confirmText: '确定', danger: false });
let dialogResolve = null;

export function useConfirm() {
  function askConfirm(opts) {
    if (dialog.value.open) return Promise.resolve(false);
    return new Promise((resolve) => {
      dialogResolve = resolve;
      Object.assign(dialog.value, opts, { open: true });
    });
  }
  function answerConfirm(ok) {
    dialog.value.open = false;
    const resolve = dialogResolve;
    dialogResolve = null;
    if (resolve) resolve(ok);
  }
  return { dialog, askConfirm, answerConfirm };
}
