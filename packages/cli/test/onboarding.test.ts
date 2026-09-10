import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeConfigPath, markOnboardingDone } from '../src/onboarding.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-onboarding-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Claude Code's first-run flag", () => {
  test('is written into a config that does not exist yet, private to the user', () => {
    const path = join(dir, '.claude.json');
    expect(markOnboardingDone(path)).toBe('marked');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ hasCompletedOnboarding: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('is added to an existing config without touching anything else in it', () => {
    const path = join(dir, '.claude.json');
    writeFileSync(path, JSON.stringify({ oauthAccount: { emailAddress: 'x@y.z' }, theme: 'dark', numStartups: 3 }));
    expect(markOnboardingDone(path)).toBe('marked');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      oauthAccount: { emailAddress: 'x@y.z' },
      theme: 'dark',
      numStartups: 3,
      hasCompletedOnboarding: true,
    });
  });

  test('a config that already carries it is left exactly as it was', () => {
    const path = join(dir, '.claude.json');
    const text = '{"hasCompletedOnboarding":true,"theme":"light"}';
    writeFileSync(path, text);
    expect(markOnboardingDone(path)).toBe('already');
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  test('a config that cannot be read is never overwritten', () => {
    const path = join(dir, '.claude.json');
    for (const text of ['{not json', '[]', '"str"']) {
      writeFileSync(path, text);
      expect(markOnboardingDone(path)).toBe('unreadable');
      expect(readFileSync(path, 'utf8')).toBe(text);
    }
  });

  test('the file lives in CLAUDE_CONFIG_DIR when set, else beside the home directory', () => {
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: '/x/cfg', HOME: '/home/less' })).toBe('/x/cfg/.claude.json');
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: '  ', HOME: '/home/less' })).toBe('/home/less/.claude.json');
    expect(claudeConfigPath({ HOME: '/root' })).toBe('/root/.claude.json');
  });
});
