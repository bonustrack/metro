import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url).href);

function git(args: string): string {
  try {
    return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const commit = process.env.COMMIT_REF ?? process.env.GIT_COMMIT ?? git('rev-parse HEAD');
const commitTime = process.env.GIT_COMMIT_TIME ?? git('show -s --format=%cI HEAD');

const proxyTarget = process.env.METRO_MCP_PROXY_TARGET ?? 'http://127.0.0.1:8420';

const extensions = ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'];

export default defineConfig({
  plugins: [react()],
  define: {
    global: 'globalThis',
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
    __METRO_COMMIT__: JSON.stringify(commit === '' ? 'dev' : commit),
    __METRO_COMMIT_TIME__: JSON.stringify(commitTime),
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
