import { single } from '@stage-labs/config/eslint/single';

export default [
  ...single({
    tsconfigRootDir: import.meta.dirname,
    ignores: ['src/mcp/**'],
  }),
  {
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      complexity: 'off',
    },
  },
];
