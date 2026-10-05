import { defineConfig } from '@stage-labs/config';

export default defineConfig({
  knip: {
    ignore: ['stage.config.js', 'plugin/**', 'scripts/compat/**', 'scripts/metro-user/**', 'scripts/app/**', 'scripts/sdk-runner/**'],
  },
  workspaces: {
    'apps/app': {
      type: 'react-native',
      src: ['src/**'],
      knip: {
        entry: ['src/app/**/*.{ts,tsx}', 'src/**/*.web.{ts,tsx}', 'babel.config.js', 'fingerprint.config.js'],
        project: ['src/**/*.{ts,tsx}'],
        ignoreDependencies: ['babel-preset-expo', '@types/qrcode'],
      },
    },
    'packages/client': {
      type: 'library',
      knip: {
        entry: ['test/**/*.ts'],
        project: ['src/**/*.ts'],
        includeEntryExports: true,
      },
    },
    'apps/bundler': {
      type: 'worker',
      knip: { entry: ['test/**/*.ts'] },
    },
    'apps/api': {
      type: 'library',
      knip: {
        entry: ['test/**/*.ts'],
        project: ['src/**/*.ts'],
      },
    },
    'packages/cli': {
      type: 'library',
      knip: {
        project: ['src/**/*.ts'],
        entry: ['scripts/*.mjs', 'test/**/*.ts'],
        ignoreBinaries: ['ps', 'claude', 'getent'],
      },
    },
    'apps/daemon': {
      type: 'library',
      knip: {
        entry: ['test/**/*.{ts,mjs}'],
        project: ['src/**/*.ts'],
        ignoreBinaries: ['getent', 'mktemp', 'ps'],
      },
    },
    'packages/core': {
      type: 'library',
      knip: {
        entry: ['test/**/*.ts'],
        project: ['src/**/*.ts'],
        ignoreBinaries: ['mktemp'],
      },
    },
    'packages/http': {
      type: 'library',
      knip: {
        entry: ['test/**/*.ts'],
        project: ['src/**/*.ts'],
      },
    },
    'packages/sdk-runner': {
      type: 'library',
      knip: {
        entry: ['test/**/*.ts'],
        project: ['src/**/*.ts'],
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
    'packages/threema': {
      type: 'library',
      knip: { project: ['src/**/*.ts'] },
    },
    'packages/outlook': {
      type: 'library',
      knip: { project: ['src/**/*.ts'] },
    },
    'packages/gmail': {
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
