import { createApp } from 'vue';
import { createPinia } from 'pinia';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import App from './App.vue';
import './style.css';
import { startWs } from './ws-client';
import { useAppStore } from './stores/app';

const app = createApp(App);
app.use(createPinia());
app.mount('#app');

startWs();
const appStore = useAppStore();
appStore.initTheme();
appStore.loadHealth();
