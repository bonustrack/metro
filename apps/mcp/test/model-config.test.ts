import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyModelUpdate,
  ModelConfigError,
  notReady,
  publicModelConfig,
  readModelConfig,
  resolveRoute,
  routeLabel,
  writeModelConfig,
  type ModelConfig,
} from '../src/gateway/model-config.ts';

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'metro-model-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const configured: ModelConfig = {
  version: 1,
  provider: 'bedrock',
  bedrock: { region: 'eu-central-1', apiKey: 'aws-key', model: '' },
  openrouter: { apiKey: 'or-key', model: 'openai/gpt-5.2-codex' },
  codex: { model: '', auth: null },
};

describe('the model route on disk', () => {
  test('a missing file means Anthropic passthrough; a bad file never throws', () => {
    const dir = scratch();
    expect(readModelConfig(dir).provider).toBe('anthropic');
    writeFileSync(join(dir, 'model.json'), '{"provider":"mars","bedrock":7}');
    expect(readModelConfig(dir)).toEqual({
      version: 1,
      provider: 'anthropic',
      bedrock: { region: '', apiKey: '', model: '' },
      openrouter: { apiKey: '', model: '' },
      codex: { model: '', auth: null },
    });
  });

  test('written 0600, read back whole, and the public view carries no key', () => {
    const dir = scratch();
    writeModelConfig(configured, dir);
    expect(statSync(join(dir, 'model.json')).mode & 0o777).toBe(0o600);
    expect(readModelConfig(dir)).toEqual(configured);
    const shown = publicModelConfig(configured);
    expect(JSON.stringify(shown)).not.toContain('aws-key');
    expect(JSON.stringify(shown)).not.toContain('or-key');
    expect(shown).toMatchObject({ provider: 'bedrock', ready: true, reason: null, bedrock: { region: 'eu-central-1', hasKey: true }, openrouter: { hasKey: true } });
    expect(existsSync(join(dir, 'model.json'))).toBe(true);
    expect(readFileSync(join(dir, 'model.json'), 'utf8')).toContain('aws-key');
  });
});

describe('updating the route from the page', () => {
  test('a partial patch keeps what it does not name, an omitted key stays and an empty key clears', () => {
    const next = applyModelUpdate(configured, { provider: 'openrouter', openrouter: { model: 'anthropic/claude-sonnet-4.5' } });
    expect(next.provider).toBe('openrouter');
    expect(next.openrouter).toEqual({ apiKey: 'or-key', model: 'anthropic/claude-sonnet-4.5' });
    expect(next.bedrock).toEqual(configured.bedrock);
    expect(applyModelUpdate(configured, { bedrock: { apiKey: '' } }).bedrock.apiKey).toBe('');
    expect(applyModelUpdate(configured, { bedrock: { region: '  us-east-1  ' } }).bedrock.region).toBe('us-east-1');
  });

  test('a bad provider, a non-string field or an oversized field is refused by name', () => {
    expect(() => applyModelUpdate(configured, { provider: 'mars' })).toThrow(ModelConfigError);
    expect(() => applyModelUpdate(configured, { bedrock: { region: 5 } })).toThrow(/Bedrock region/);
    expect(() => applyModelUpdate(configured, { openrouter: { apiKey: 'x'.repeat(600) } })).toThrow(/too long/);
    expect(() => applyModelUpdate(configured, 'nope')).toThrow(/JSON object/);
  });

  test('readiness names the missing piece', () => {
    expect(notReady({ ...configured, provider: 'anthropic' })).toBeNull();
    expect(notReady({ ...configured, bedrock: { ...configured.bedrock, apiKey: '' } })).toMatch(/API key/);
    expect(notReady({ ...configured, bedrock: { ...configured.bedrock, region: '' } })).toMatch(/region/);
    expect(notReady({ ...configured, provider: 'openrouter', openrouter: { apiKey: 'k', model: '' } })).toMatch(/model id/);
  });
});

describe('resolving a request to a route', () => {
  test('a plain Claude id goes to the chosen provider, an explicit prefix wins for that request', () => {
    expect(resolveRoute('claude-sonnet-4-6', configured)).toEqual({ provider: 'bedrock', model: 'claude-sonnet-4-6' });
    expect(resolveRoute('openrouter:google/gemini-2.5-pro', configured)).toEqual({ provider: 'openrouter', model: 'google/gemini-2.5-pro' });
    expect(resolveRoute('anthropic:claude-opus-4-8', configured)).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8' });
    expect(resolveRoute('mars:x', configured)).toEqual({ provider: 'bedrock', model: 'mars:x' });
  });

  test('a pinned Bedrock model replaces what Claude Code asked for; OpenRouter uses its own id unless one was given', () => {
    const pinned = { ...configured, bedrock: { ...configured.bedrock, model: 'eu.anthropic.claude-sonnet-4-6' } };
    expect(resolveRoute('claude-opus-5', pinned).model).toBe('eu.anthropic.claude-sonnet-4-6');
    const or = { ...configured, provider: 'openrouter' as const };
    expect(resolveRoute('claude-sonnet-5', or)).toEqual({ provider: 'openrouter', model: 'openai/gpt-5.2-codex' });
    expect(resolveRoute('anthropic/claude-sonnet-4.5', or).model).toBe('anthropic/claude-sonnet-4.5');
    expect(routeLabel({ provider: 'anthropic', model: 'claude-sonnet-5' })).toBe('claude-sonnet-5');
    expect(routeLabel({ provider: 'openrouter', model: 'x/y' })).toBe('openrouter:x/y');
  });
});

describe('the Codex route', () => {
  const signedIn = { ...configured, provider: 'codex' as const, codex: { model: 'gpt-5.3-codex', auth: { accessToken: 'at', refreshToken: 'rt', idToken: '', accountId: 'acct', email: 'l@x', plan: 'pro', savedAt: '2026-09-07T00:00:00.000Z' } } };

  test('needs a sign-in and a model, keeps its tokens through a page update, and shows only the account', () => {
    expect(notReady({ ...signedIn, codex: { ...signedIn.codex, auth: null } })).toMatch(/sign in/);
    expect(notReady({ ...signedIn, codex: { ...signedIn.codex, model: '' } })).toMatch(/model id/);
    expect(notReady(signedIn)).toBeNull();
    const updated = applyModelUpdate(signedIn, { codex: { model: 'gpt-5.4' } });
    expect(updated.codex).toEqual({ ...signedIn.codex, model: 'gpt-5.4' });
    const shown = publicModelConfig(signedIn);
    expect(shown).toMatchObject({ provider: 'codex', ready: true, codex: { model: 'gpt-5.3-codex', signedIn: true, account: 'l@x', plan: 'pro' } });
    expect(JSON.stringify(shown)).not.toContain('"at"');
    const dir = scratch();
    writeModelConfig(signedIn, dir);
    expect(readModelConfig(dir)).toEqual(signedIn);
  });

  test('a Claude id maps to the page model, a gpt id passes, a prefix wins', () => {
    expect(resolveRoute('claude-sonnet-5', signedIn)).toEqual({ provider: 'codex', model: 'gpt-5.3-codex' });
    expect(resolveRoute('gpt-5.4', signedIn)).toEqual({ provider: 'codex', model: 'gpt-5.4' });
    expect(resolveRoute('codex:gpt-5.2-codex', configured)).toEqual({ provider: 'codex', model: 'gpt-5.2-codex' });
  });
});
