const knipConfig = {
  $schema: 'https://unpkg.com/knip@6/schema.json',
  ignoreExportsUsedInFile: true,
  entry: [
    'src/stations/**/index.ts',
    'src/trains/**/*.ts',
    'scripts/**/*.{mjs,js}',
    'test/**/*.{ts,mjs}',
  ],
  project: ['src/**/*.ts', 'scripts/**/*.{mjs,js}'],
  ignoreBinaries: ['mktemp', 'claude'],
  ignore: [
    'src/broker/claims.ts',
    'src/broker/history-stream.ts',
    'src/tunnel.ts',
    'src/paths.ts',
    'src/secure-fs.ts',
  ],
};

export default knipConfig;
