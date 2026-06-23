const knipConfig = {
  $schema: 'https://unpkg.com/knip@6/schema.json',
  ignoreExportsUsedInFile: true,
  entry: [
    'src/types.ts',
    'src/station-runtime.ts',
    'src/account-store.ts',
    'src/attachments.ts',
    'src/messaging-normalize.ts',
  ],
  project: ['src/**/*.ts'],
};

export default knipConfig;
