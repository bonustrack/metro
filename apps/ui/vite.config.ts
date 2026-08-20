import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url).href);

const proxyTarget = process.env.METRO_MCP_PROXY_TARGET ?? 'http://127.0.0.1:8420';

const extensions = ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'];

export default defineConfig({
  plugins: [react()],
  define: {
    global: 'globalThis',
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
  },
  resolve: {
    alias: { 'react-native': 'react-native-web' },
    extensions,
  },
  optimizeDeps: {
    include: ['react-native-web', '@stage-labs/kit', '@stage-labs/kit > qrcode'],
    esbuildOptions: {
      resolveExtensions: extensions,
      loader: { '.js': 'jsx' },
    },
  },
  server: {
    port: 5175,
    fs: { allow: [repoRoot] },
    proxy: {
      '/mcp': { target: proxyTarget, changeOrigin: true },
      '/api': { target: proxyTarget, changeOrigin: true },
    },
  },
});
