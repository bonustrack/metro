const { execSync } = require('node:child_process');

function git(args) {
  try {
    return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function gitHash() {
  const fromEnv = process.env.EAS_BUILD_GIT_COMMIT_HASH || process.env.COMMIT_REF || process.env.GIT_COMMIT;
  if (fromEnv) return fromEnv;
  return git('rev-parse HEAD') || 'dev';
}

function commitTime() {
  return process.env.GIT_COMMIT_TIME || git('show -s --format=%cI HEAD');
}

const EAS_PROJECT_ID = '51aa82e1-6457-4e12-a9c2-30def4397e20';

const IS_PROD = process.env.APP_VARIANT === 'prod';

const variant = IS_PROD
  ? { name: 'Metro', id: 'box.metro' }
  : { name: 'Metro Dev', id: 'box.metro.dev' };

const BACKGROUND = '#0e0f10';

const config = {
  name: variant.name,
  slug: 'metro-app',
  scheme: 'metro',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  runtimeVersion: { policy: 'fingerprint' },
  ...(EAS_PROJECT_ID === ''
    ? {}
    : {
        updates: {
          enabled: true,
          checkAutomatically: 'NEVER',
          fallbackToCacheTimeout: 0,
          url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
        },
      }),
  ios: {
    supportsTablet: true,
    bundleIdentifier: variant.id,
    config: { usesNonExemptEncryption: false },
  },
  android: {
    package: variant.id,
    versionCode: 1,
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: BACKGROUND,
    },
    predictiveBackGestureEnabled: false,
    softwareKeyboardLayoutMode: 'resize',
    allowBackup: false,
    intentFilters: [
      {
        action: 'VIEW',
        data: [{ scheme: 'metro' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  },
  web: {
    bundler: 'metro',
    output: 'single',
    favicon: './assets/favicon.png',
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-font',
    'expo-web-browser',
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        resizeMode: 'contain',
        imageWidth: 120,
        backgroundColor: '#ffffff',
        dark: { image: './assets/splash-icon-dark.png', backgroundColor: BACKGROUND },
      },
    ],
    [
      'expo-build-properties',
      {
        android: { compileSdkVersion: 36, targetSdkVersion: 36 },
      },
    ],
  ],
  extra: {
    router: {},
    ...(EAS_PROJECT_ID === '' ? {} : { eas: { projectId: EAS_PROJECT_ID } }),
    gitHash: gitHash(),
    commitTime: commitTime(),
    buildProfile: process.env.EAS_BUILD_PROFILE || 'dev',
  },
  owner: 'bonustrack',
};

module.exports = { expo: config };
