const knipConfig = {
  $schema: 'https://unpkg.com/knip@6/schema.json',
  ignoreExportsUsedInFile: true,
  entry: ['scripts/login.ts'],
  project: ['src/**/*.ts'],
};

export default knipConfig;
