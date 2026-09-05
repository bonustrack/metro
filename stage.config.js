import { defineConfig } from '@stage-labs/config';

export default defineConfig({
  eslint: {
    ignores: [
      '**/test/**',
      '**/scripts/**',
      'packages/cli/runtime/**',
      'apps/mcp/trains/**',
    ],
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
    ignore: ['stage.config.js', 'plugin/**'],
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
      knip: {
        project: ['src/**/*.ts'],
        entry: ['scripts/*.mjs', 'test/**/*.ts'],
        ignoreBinaries: ['ps', 'claude'],
      },
    },
    'apps/mcp': {
      type: 'library',
      knip: {
        entry: ['test/**/*.{ts,mjs}'],
        project: ['src/**/*.ts'],
        ignoreBinaries: ['mktemp', 'ps', 'tmux'],
      },
    },
    'packages/webhook': {
      type: 'library',
      knip: { project: ['src/**/*.ts'] },
    },
    'packages/discord-bot': {
      type: 'library',
      knip: { project: ['src/**/*.ts'] },
    },
    'packages/telegram-bot': {
      type: 'library',
      knip: { project: ['src/**/*.ts'] },
    },
    'packages/telegram': {
      type: 'library',
      knip: { project: ['src/**/*.ts'] },
    },
    'packages/whatsapp': {
      type: 'library',
      knip: { project: ['src/**/*.ts'] },
    },
    'packages/xmtp': {
      type: 'library',
      knip: { project: ['src/**/*.ts'] },
    },
  },
});
