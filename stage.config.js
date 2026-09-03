const STAGED_RUNTIME_DEPENDENCIES = [
  '@discordjs/voice',
  '@modelcontextprotocol/sdk',
  '@mtcute/bun',
  '@xmtp/content-type-primitives',
  '@xmtp/content-type-reaction',
  '@xmtp/content-type-remote-attachment',
  '@xmtp/content-type-reply',
  '@xmtp/content-type-wallet-send-calls',
  '@xmtp/node-bindings',
  '@xmtp/node-sdk',
  'baileys',
  'discord.js',
  'drizzle-orm',
  'pino',
  'pino-pretty',
  'postgres',
  'prism-media',
  'viem',
  'zod',
];

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
        entry: ['src/**/*.ts', 'scripts/*.mjs', 'test/**/*.ts'],
        ignoreBinaries: ['tail', 'ps', 'claude'],
        ignoreDependencies: STAGED_RUNTIME_DEPENDENCIES,
      },
    },
    'apps/mcp': {
      type: 'library',
      knip: {
        entry: ['src/daemon/**/*.ts', 'test/**/*.{ts,mjs}'],
        project: ['src/**/*.ts'],
        ignoreBinaries: ['mktemp', 'claude', 'ps'],
        ignore: ['src/daemon/tunnel.ts'],
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
