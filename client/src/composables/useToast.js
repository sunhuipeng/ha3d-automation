import { ref } from 'vue';
/* 全局提醒 toast（审计 3.2 从 App.vue 抽出）：模块级单例状态，
 * 任何组件 useToast() 拿到的是同一份 toast / notify——报错与提醒统一在中上部弹出 */
const toast = ref({ text: '', kind: 'error' });
let toastTimer = null;

export function useToast() {
  function notify(text, kind = 'error') {
    toast.value = { text: String(text || ''), kind };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.value.text = ''; }, 4200);
  }
  return { toast, notify };
}
