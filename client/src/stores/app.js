import { defineStore } from 'pinia';

/* 主题持久化：默认亮色，键名独立于 studio（studio.dark） */
const DARK_KEY = 'automation.dark';
function loadDark() {
  try { return localStorage.getItem(DARK_KEY) === '1'; } catch (e) { return false; }
}
function applyDarkToDom(on) {
  const root = document.documentElement;
  root.setAttribute('data-theme', on ? 'dark' : 'light');
}

export const useAppStore = defineStore('app', {
  state: () => ({
    dark: loadDark(),
    haStatus: 'disconnected',
    wsConnected: false,
    devMode: false,      // 全局开发模式（服务端 HA3D_DEV_MODE）：只拦脚本发起的 HA 写；发布/恢复/上下文按通道语义，前端展示横幅
    mcp: { active: false, connected: false, busy: false, text: '' },
  }),
  actions: {
    toggleTheme() {
      this.dark = !this.dark;
      applyDarkToDom(this.dark);
      try { localStorage.setItem(DARK_KEY, this.dark ? '1' : '0'); } catch (e) {}
    },
    initTheme() { applyDarkToDom(this.dark); },
    async loadHealth() {
      try {
        const r = await fetch('/api/health').then((x) => x.json());
        this.haStatus = r.ha || 'disconnected';
        this.devMode = r.devMode === true;
      } catch (e) { this.haStatus = 'error'; }
    },
    setHaStatus(s) { this.haStatus = s; },
  },
});
