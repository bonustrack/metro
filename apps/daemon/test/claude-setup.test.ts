import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { handleClaudeRequest } from '../src/claude/api.js';
import { claudeSetupStatus, ensureClaudeSetup, PRIVACY_ENV, RETENTION_DAYS, routeOf, setPrivacy, syncAvailableModels, type SetupDeps } from '../src/claude/setup.js';
import { readModelConfig } from '../src/gateway/model-config.js';
import { auth } from './identity-helper.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const GUIDANCE = join(import.meta.dir, '..', '..', '..', 'plugin', 'orchestrator.md');

let dir = '';
const deps = (): SetupDeps => ({ dir: join(dir, 'claude'), agents: join(dir, 'agents'), guidance: GUIDANCE });
const settings = (): Record<string, unknown> => JSON.parse(readFileSync(join(dir, 'claude', 'settings.json'), 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-claude-setup-'));
  mkdirSync(join(dir, 'claude'));
  mkdirSync(join(dir, 'agents'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the Claude Code setup a metro box gets', () => {
  test('writes the worker agent, the orchestrator skill and the privacy settings once, and leaves them alone after', () => {
    const first = ensureClaudeSetup(deps());
    expect(first).toEqual({ privacy: true, guard: 'plugin', worker: 'written', skill: 'written', settings: 'written' });
    expect(readFileSync(join(dir, 'claude', 'agents', 'worker.md'), 'utf8')).toContain('name: worker');
    expect(readFileSync(join(dir, 'claude', 'skills', 'metro-orchestrator', 'SKILL.md'), 'utf8')).toContain('name: metro-orchestrator');
    expect(settings()).toEqual({ env: PRIVACY_ENV, cleanupPeriodDays: RETENTION_DAYS });
    writeFileSync(join(dir, 'claude', 'skills', 'metro-orchestrator', 'SKILL.md'), 'edited by hand');
    expect(ensureClaudeSetup(deps())).toEqual({ privacy: true, guard: 'plugin', worker: 'present', skill: 'present', settings: 'unchanged' });
    expect(readFileSync(join(dir, 'claude', 'skills', 'metro-orchestrator', 'SKILL.md'), 'utf8')).toBe('edited by hand');
  });

  test('merges into settings the user already has, keeps their retention, and never touches a broken file', () => {
    writeFileSync(join(dir, 'claude', 'settings.json'), JSON.stringify({ env: { MY_VAR: 'x' }, cleanupPeriodDays: 30, hooks: { PreToolUse: [] } }));
    expect(ensureClaudeSetup(deps()).settings).toBe('written');
    expect(settings()).toEqual({ env: { MY_VAR: 'x', ...PRIVACY_ENV }, cleanupPeriodDays: 30, hooks: { PreToolUse: [] } });
    writeFileSync(join(dir, 'claude', 'settings.json'), '{broken');
    expect(ensureClaudeSetup(deps()).settings).toBe('unreadable');
    expect(readFileSync(join(dir, 'claude', 'settings.json'), 'utf8')).toBe('{broken');
  });

  test('privacy off removes exactly the four variables and keeps everything else', () => {
    ensureClaudeSetup(deps());
    writeFileSync(join(dir, 'claude', 'settings.json'), JSON.stringify({ env: { ...PRIVACY_ENV, MY_VAR: 'x' }, cleanupPeriodDays: 7 }));
    setPrivacy(false, join(dir, 'agents'));
    expect(ensureClaudeSetup(deps())).toMatchObject({ privacy: false, settings: 'written' });
    expect(settings()).toEqual({ env: { MY_VAR: 'x' }, cleanupPeriodDays: 7 });
    expect(claudeSetupStatus(deps())).toEqual({ privacy: false, permissionMode: 'auto', guard: 'plugin', worker: true, skill: true, privacyApplied: false, retentionDays: 7 });
  });

  test('a missing guidance file is reported, not thrown', () => {
    const report = ensureClaudeSetup({ ...deps(), guidance: join(dir, 'nowhere.md') });
    expect(report.skill).toBe('missing');
    expect(existsSync(join(dir, 'claude', 'skills', 'metro-orchestrator'))).toBe(false);
  });
});

describe('the setup over the API', () => {
  let server: Server;
  let base = '';

  beforeEach(async () => {
    server = createServer((req, res) => {
      const ok = handleClaudeRequest(req, res, {
        authorize: (subject: string) => {
          if (subject !== OWNER) throw new ApiError('no such project', 404);
        },
        setup: deps(),
        session: { tmux: join(dir, 'no-tmux-here') },
      });
      if (!ok) res.writeHead(404).end();
    });
    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterEach(() => {
    server.close();
  });

  const call = async (method: string, body?: unknown): Promise<Response> =>
    fetch(`${base}/api/claude/setup`, {
      method,
      headers: { authorization: await auth(method, '/api/claude/setup', OWNER), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test('the owner reads the status and flips privacy, which rewrites the settings at once', async () => {
    expect((await (await call('GET')).json()) as unknown).toMatchObject({ privacy: true, worker: false, skill: false, privacyApplied: false });
    const off = (await (await call('POST', { privacy: false })).json()) as { privacy: boolean; worker: boolean; skill: boolean; privacyApplied: boolean };
    expect(off).toMatchObject({ privacy: false, worker: true, skill: true, privacyApplied: false });
    const on = (await (await call('POST', { privacy: true })).json()) as { privacyApplied: boolean; retentionDays: number };
    expect(on).toMatchObject({ privacyApplied: true, retentionDays: RETENTION_DAYS });
    expect((await call('POST', { privacy: 'yes' })).status).toBe(400);
  });
});

describe("Claude Code's model allowlist follows the Model page", () => {
  const cfg = (over: Record<string, unknown>): ReturnType<typeof readModelConfig> => ({ ...readModelConfig(join(dir, 'nowhere')), ...over }) as ReturnType<typeof readModelConfig>;

  test('a non-Anthropic route becomes the only model Claude Code offers, and Anthropic clears it again', () => {
    const openrouter = cfg({ provider: 'openrouter', openrouter: { apiKey: 'k', model: 'anthropic/claude-sonnet-5', zdr: true } });
    expect(routeOf(openrouter)).toBe('openrouter:anthropic/claude-sonnet-5');
    writeFileSync(join(dir, 'claude', 'settings.json'), JSON.stringify({ env: { MY_VAR: 'x' } }));
    expect(syncAvailableModels(openrouter, deps())).toBe('written');
    expect(settings()).toEqual({ env: { MY_VAR: 'x' }, availableModels: ['openrouter:anthropic/claude-sonnet-5'], enforceAvailableModels: true });
    expect(syncAvailableModels(openrouter, deps())).toBe('unchanged');
    expect(syncAvailableModels(cfg({ provider: 'anthropic' }), deps())).toBe('written');
    expect(settings()).toEqual({ env: { MY_VAR: 'x' } });
  });

  test('an allowlist the user wrote themselves is left alone when the route is Anthropic', () => {
    writeFileSync(join(dir, 'claude', 'settings.json'), JSON.stringify({ availableModels: ['claude-opus-5'] }));
    expect(syncAvailableModels(cfg({ provider: 'anthropic' }), deps())).toBe('unchanged');
    expect(settings()).toEqual({ availableModels: ['claude-opus-5'] });
  });
});

describe('the permission mode of the session', () => {
  let server: Server;
  let base = '';
  beforeEach(async () => {
    server = createServer((req, res) => {
      const ok = handleClaudeRequest(req, res, { authorize: () => undefined, setup: deps(), session: { tmux: join(dir, 'no-tmux-here') } });
      if (!ok) res.writeHead(404).end();
    });
    await new Promise<void>((done) => {
      server.listen(0, '127.0.0.1', done);
    });
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterEach(() => {
    server.close();
  });
  const call = async (method: string, body?: unknown): Promise<Response> =>
    fetch(`${base}/api/claude/setup`, {
      method,
      headers: { authorization: await auth(method, '/api/claude/setup', OWNER), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test('is auto until flipped, keeps the other setup state, and is refused when not a mode', async () => {
    const before = (await (await call('GET')).json()) as { permissionMode: string };
    expect(before.permissionMode).toBe('auto');
    const flipped = (await (await call('POST', { permissionMode: 'bypass' })).json()) as { permissionMode: string; privacy: boolean };
    expect(flipped).toMatchObject({ permissionMode: 'bypass', privacy: true });
    await call('POST', { privacy: false });
    const both = (await (await call('GET')).json()) as { permissionMode: string; privacy: boolean };
    expect(both).toMatchObject({ permissionMode: 'bypass', privacy: false });
    expect((await call('POST', { permissionMode: 'sometimes' })).status).toBe(400);
    expect((await call('POST', {})).status).toBe(400);
  });
});
