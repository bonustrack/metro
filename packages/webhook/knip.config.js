const knipConfig = {
  $schema: 'https://unpkg.com/knip@6/schema.json',
  ignoreExportsUsedInFile: true,
  entry: ['src/station.ts'],
  project: ['src/**/*.ts'],
};

export default knipConfig;
