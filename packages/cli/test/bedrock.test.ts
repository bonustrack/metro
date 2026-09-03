import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeEnv,
  firstPartyModelId,
  PROVIDER_FLAGS,
  settingsConflicts,
  settingsFiles,
} from '../src/bedrock.ts';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-bedrock-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the environment Claude Code is launched with', () => {
  test('every third-party provider flag and the Bedrock key are scrubbed', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      AWS_BEARER_TOKEN_BEDROCK: 'secret',
      ANTHROPIC_API_KEY: 'sk-ant',
    };
    for (const flag of PROVIDER_FLAGS) base[flag] = '1';
    const env = claudeEnv(base, 4321, 'mb_x');
    for (const flag of PROVIDER_FLAGS) expect(env[flag]).toBeUndefined();
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4321');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('mb_x');
    expect(env.PATH).toBe('/usr/bin');
  });
});

describe('the model Claude Code is told it is on', () => {
  test('a pinned Bedrock id is translated back to its first-party id', () => {
    expect(firstPartyModelId('eu.anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(firstPartyModelId('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('claude-haiku-4-5-20251001');
    expect(firstPartyModelId('anthropic.claude-opus-4-6')).toBe('claude-opus-4-6');
  });

  test('ANTHROPIC_MODEL follows the pin, but never overrides one the user set', () => {
    expect(claudeEnv({}, 1, 't', 'eu.anthropic.claude-sonnet-4-6').ANTHROPIC_MODEL).toBe('claude-sonnet-4-6');
    expect(claudeEnv({ ANTHROPIC_MODEL: 'claude-opus-4-6' }, 1, 't', 'eu.anthropic.claude-sonnet-4-6').ANTHROPIC_MODEL).toBe('claude-opus-4-6');
    expect(claudeEnv({}, 1, 't', null).ANTHROPIC_MODEL).toBeUndefined();
  });
});

describe('settings that would defeat the proxy', () => {
  test('a provider flag or base url in a settings env block is reported by file and key', () => {
    const user = join(dir, 'settings.json');
    writeFileSync(user, JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://x' } }));
    const project = join(dir, 'proj', '.claude');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: 'true' } }));
    const files = settingsFiles(join(dir, 'proj'), { CLAUDE_CONFIG_DIR: dir });
    expect(settingsConflicts(files)).toEqual([
      `${user}: CLAUDE_CODE_USE_BEDROCK`,
      `${user}: ANTHROPIC_BASE_URL`,
      `${join(project, 'settings.json')}: CLAUDE_CODE_USE_VERTEX`,
    ]);
  });

  test('missing files, empty values and unrelated keys are not conflicts', () => {
    const clean = join(dir, 'clean');
    mkdirSync(clean, { recursive: true });
    writeFileSync(join(clean, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '', FOO: 'bar' } }));
    expect(settingsConflicts(settingsFiles(join(dir, 'nowhere'), { CLAUDE_CONFIG_DIR: clean }))).toEqual([]);
  });

  test('a home directory used as the project does not list the same file twice', () => {
    const files = settingsFiles('/home/u', { CLAUDE_CONFIG_DIR: '/home/u/.claude' });
    expect(files).toEqual(['/home/u/.claude/settings.json', '/home/u/.claude/settings.local.json']);
  });

  test('CLAUDE_CONFIG_DIR picks the profile, so a separate one keeps Bedrock mode elsewhere', () => {
    const files = settingsFiles('/work', { CLAUDE_CONFIG_DIR: '/profiles/mb' });
    expect(files[0]).toBe('/profiles/mb/settings.json');
  });
});
