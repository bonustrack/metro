const knipConfig = {
  $schema: 'https://unpkg.com/knip@6/schema.json',
  ignoreExportsUsedInFile: true,
  entry: [
    'src/daemon/**/*.ts',
    'scripts/**/*.{mjs,js}',
    'test/**/*.{ts,mjs}',
  ],
  project: ['src/**/*.ts', 'scripts/**/*.{mjs,js}'],
  ignoreBinaries: ['mktemp', 'claude'],
  ignore: [
    'src/daemon/tunnel.ts',
  ],
};

export default knipConfig;
