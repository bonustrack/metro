import { describe, expect, test } from 'bun:test';
import { claudeTokenIn, isClaudeToken, withoutClaudeTokens } from '../src/claude-token.js';

const TOKEN = `sk-ant-oat01-${'A1b2_C3d4-'.repeat(9)}xyzAA`;

describe('the long-lived Claude token that claude setup-token prints', () => {
  test('only the sk-ant-oat01- shape of a sane length passes', () => {
    expect(isClaudeToken(TOKEN)).toBe(true);
    expect(isClaudeToken(`${TOKEN} `)).toBe(false);
    expect(isClaudeToken('sk-ant-oat01-short')).toBe(false);
    expect(isClaudeToken(`sk-ant-api03-${'a'.repeat(90)}`)).toBe(false);
    expect(isClaudeToken(`sk-ant-oat01-${'a'.repeat(600)}`)).toBe(false);
    expect(isClaudeToken(`sk-ant-oat01-${'a'.repeat(40)}!`)).toBe(false);
  });

  test('the last whole token in the output is picked, and every token-shaped run is hidden', () => {
    const older = `sk-ant-oat01-${'z'.repeat(40)}`;
    const output = `Your OAuth token (valid for 1 year):\r\n\r\n${older}\r\n${TOKEN}\r\nStore this token securely.\r\nexport CLAUDE_CODE_OAUTH_TOKEN=<token>`;
    expect(claudeTokenIn(output)).toBe(TOKEN);
    expect(claudeTokenIn('no token here, only sk-ant-oat01-abc')).toBeNull();
    const hidden = withoutClaudeTokens(`${output} and a cut one sk-ant-oat01-abc`);
    expect(hidden).not.toContain('sk-ant-oat01-');
    expect(hidden).toContain('[token]\r\n[token]\r\nStore');
    expect(hidden).toContain('CLAUDE_CODE_OAUTH_TOKEN=<token>');
  });
});
