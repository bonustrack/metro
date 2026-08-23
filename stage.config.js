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
      {
        files: ['**/*.tsx'],
        rules: {
          'no-restricted-syntax': [
            'error',
            {
              selector:
                'JSXAttribute[name.name=/[Ss]tyle$/] > JSXExpressionContainer > ObjectExpression',
              message:
                'No inline style objects in JSX. Use the kit props (gap, padding, flex, radius, surface, border, minWidth...) or a named style constant.',
            },
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
    'packages/cli': {
      type: 'library',
      knip: { project: ['src/**/*.ts'] },
    },
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
      knip: {
        entry: ['scripts/task-status.ts'],
        project: ['src/**/*.ts'],
      },
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
