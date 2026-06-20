import { single } from '@stage-labs/config/eslint/single';

// src/mcp/** is the in-process MCP surface, written in MCP-SDK idiom (no
// semicolons, long header comments) and stays out of the lint surface.
// It IS typechecked + built with the daemon.
export default [
  ...single({
    tsconfigRootDir: import.meta.dirname,
    ignores: ['src/mcp/**'],
  }),
  // metro is intentionally comment-heavy (long header comments, inline notes).
  // Relax stage's comment-policy and jsdoc require-* rules to fit that style,
  // and relax the size/complexity caps — while KEEPING all the
  // typescript-eslint strict type-checked rules intact.
  {
    rules: {
      'comments/no-comments': 'off',
      'comments/no-line-comments': 'off',
      'comments/no-consecutive-comments': 'off',
      'comments/comment-max-lines': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-file-overview': 'off',
      'jsdoc/no-bad-blocks': 'off',
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      complexity: 'off',
    },
  },
];
