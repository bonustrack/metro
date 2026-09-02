import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeEnv,
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

  test('CLAUDE_CONFIG_DIR picks the profile, so a separate one keeps Bedrock mode elsewhere', () => {
    const files = settingsFiles('/work', { CLAUDE_CONFIG_DIR: '/profiles/mb' });
    expect(files[0]).toBe('/profiles/mb/settings.json');
  });
});
