import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.ALLOWANCE_URL ?? 'http://127.0.0.1:4000';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/mcp': { target: api, changeOrigin: false },
    },
  },
});
