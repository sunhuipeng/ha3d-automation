import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5176,
    proxy: { '/api': 'http://localhost:8100', '/mcp': 'http://localhost:8100', '/ws': { target: 'ws://localhost:8100', ws: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
