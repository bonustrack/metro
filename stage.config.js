import { defineConfig } from '@stage-labs/config';

export default defineConfig({
  eslint: {
    ignores: ['**/test/**', '**/scripts/**'],
    extends: [
      {
        files: ['**/*.{ts,tsx}'],
        rules: {
          '@typescript-eslint/no-floating-promises': [
            'error',
            { ignoreVoid: false },
          ],
        },
      },
    ],
  },
  knip: {
    ignore: ['stage.config.js'],
  },
  workspaces: {
    'apps/ui': {
      type: 'library',
      knip: {
        entry: ['index.html'],
        project: ['src/**/*.{ts,tsx}'],
        ignoreDependencies: ['react-native-web', '@types/qrcode'],
      },
    },
    'apps/mcp': {
      type: 'library',
      knip: {
        entry: ['src/daemon/**/*.ts', 'scripts/*.ts', 'test/**/*.{ts,mjs}'],
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
        entry: ['scripts/login.ts'],
        project: ['src/**/*.ts'],
      },
    },
    'packages/whatsapp': {
      type: 'library',
      knip: {
        entry: ['scripts/login.ts'],
        project: ['src/**/*.ts'],
      },
    },
    'packages/xmtp': {
      type: 'library',
      knip: { project: ['src/**/*.ts'] },
    },
  },
});
