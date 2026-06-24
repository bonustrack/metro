import { defineConfig } from '@stage-labs/config';

export default defineConfig({
  eslint: {
    ignores: ['**/test/**', '**/scripts/**'],
  },
  knip: {
    ignore: ['stage.config.js'],
    ignoreDependencies: ['@types/ws'],
  },
  workspaces: {
    'apps/mcp': {
      type: 'library',
      knip: {
        entry: ['src/daemon/**/*.ts', 'test/**/*.{ts,mjs}'],
        project: ['src/**/*.ts'],
        ignoreBinaries: ['mktemp', 'claude'],
        ignore: ['src/daemon/tunnel.ts'],
      },
    },
    'packages/webhook': {
      type: 'library',
      knip: { project: ['src/**/*.ts'] },
    },
    'packages/discord': {
      type: 'library',
      knip: { project: ['src/**/*.ts'] },
    },
    'packages/telegram': {
      type: 'library',
      knip: { project: ['src/**/*.ts'] },
    },
    'packages/telegram-user': {
      type: 'library',
      knip: {
        entry: ['scripts/login.ts', 'scripts/dev-local.ts'],
        project: ['src/**/*.ts'],
      },
    },
    'packages/xmtp': {
      type: 'library',
      knip: { project: ['src/**/*.ts'] },
    },
  },
});
