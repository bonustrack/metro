import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentRoute, permissionMode, routeModelEnv } from '../src/route.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-route-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the model route metro claude tells Claude Code about', () => {
  test('is provider:model from the Model page for a non-Anthropic provider, and nothing otherwise', () => {
    expect(currentRoute(dir)).toBeNull();
    writeFileSync(join(dir, 'model.json'), JSON.stringify({ provider: 'openrouter', openrouter: { model: 'anthropic/claude-sonnet-5' } }));
    expect(currentRoute(dir)).toBe('openrouter:anthropic/claude-sonnet-5');
    writeFileSync(join(dir, 'model.json'), JSON.stringify({ provider: 'anthropic', anthropic: { model: 'claude-opus-5' } }));
    expect(currentRoute(dir)).toBeNull();
    writeFileSync(join(dir, 'model.json'), JSON.stringify({ provider: 'bedrock', bedrock: { model: '' } }));
    expect(currentRoute(dir)).toBeNull();
    writeFileSync(join(dir, 'model.json'), '{broken');
    expect(currentRoute(dir)).toBeNull();
  });

  test('sets ANTHROPIC_MODEL unless the user set one', () => {
    expect(routeModelEnv({ PATH: '/bin' }, 'codex:gpt-5.4')).toEqual({ PATH: '/bin', ANTHROPIC_MODEL: 'codex:gpt-5.4' });
    expect(routeModelEnv({ PATH: '/bin', ANTHROPIC_MODEL: 'mine' }, 'codex:gpt-5.4').ANTHROPIC_MODEL).toBe('mine');
    const env = { PATH: '/bin' };
    expect(routeModelEnv(env, null)).toBe(env);
  });
});

describe('the permission mode the box chose', () => {
  test('is auto unless the setup file says bypass', () => {
    expect(permissionMode(dir)).toBe('auto');
    writeFileSync(join(dir, 'claude-setup.json'), JSON.stringify({ privacy: true, permissionMode: 'bypass' }));
    expect(permissionMode(dir)).toBe('bypass');
    writeFileSync(join(dir, 'claude-setup.json'), JSON.stringify({ permissionMode: 'weird' }));
    expect(permissionMode(dir)).toBe('auto');
  });
});
