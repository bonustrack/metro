import { describe, expect, test } from 'bun:test';
import { isClaudeToken } from '../src/claude-token.js';

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
});
