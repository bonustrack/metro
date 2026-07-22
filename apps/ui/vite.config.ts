import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const proxyTarget = process.env.METRO_MCP_PROXY_TARGET ?? 'http://127.0.0.1:8420';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      '/mcp': { target: proxyTarget, changeOrigin: true },
    },
  },
});
