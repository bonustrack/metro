import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleClaudeRequest } from '../src/claude/api.js';
import { configOf, makeConnection } from './model-fixture.ts';
import { claudeSetupStatus, ensureClaudeSetup, placeFile, PRIVACY_ENV, RETENTION_DAYS, routeOf, setPrivacy, syncAvailableModels, type SetupDeps } from '../src/claude/setup.js';
import { readModelConfig } from '../src/gateway/model-config.js';
import { auth, operatorAuth } from './identity-helper.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const PLUGIN = join(import.meta.dir, '..', '..', '..', 'plugin');
const SHIPPED_BEFORE = readFileSync(join(import.meta.dir, 'metro-orchestrator-shipped.md'), 'utf8');

let dir = '';
const deps = (): SetupDeps => ({ dir: join(dir, 'claude'), agents: join(dir, 'agents'), plugin: PLUGIN });
const skill = (name: string): string => join(dir, 'claude', 'skills', name, 'SKILL.md');
const placeSkill = (name: string, text: string): void => {
  mkdirSync(join(dir, 'claude', 'skills', name), { recursive: true });
  writeFileSync(skill(name), text);
};
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
  test('writes the worker agent, the metro, stage and memory skills and the privacy settings once, and leaves them alone after', () => {
    const first = ensureClaudeSetup(deps());
    expect(first).toEqual({ privacy: true, guard: 'plugin', worker: 'written', skill: 'written', stage: 'written', memory: 'written', settings: 'written' });
    expect(readFileSync(join(dir, 'claude', 'agents', 'worker.md'), 'utf8')).toContain('name: worker');
    expect(readFileSync(skill('metro'), 'utf8')).toBe(readFileSync(join(PLUGIN, 'METRO.md'), 'utf8'));
    expect(readFileSync(skill('metro'), 'utf8')).toContain('name: metro\n');
    expect(readFileSync(skill('stage'), 'utf8')).toContain('name: stage\n');
    expect(readFileSync(skill('memory'), 'utf8')).toBe(readFileSync(join(PLUGIN, 'MEMORY.md'), 'utf8'));
    expect(readFileSync(skill('memory'), 'utf8')).toContain('name: memory\n');
    expect(settings()).toEqual({ env: PRIVACY_ENV, cleanupPeriodDays: RETENTION_DAYS });
    writeFileSync(skill('metro'), 'edited by hand');
    writeFileSync(skill('stage'), 'stage edited by hand');
    writeFileSync(skill('memory'), 'memory edited by hand');
    expect(ensureClaudeSetup(deps())).toEqual({ privacy: true, guard: 'plugin', worker: 'present', skill: 'present', stage: 'present', memory: 'present', settings: 'unchanged' });
    expect(readFileSync(skill('metro'), 'utf8')).toBe('edited by hand');
    expect(readFileSync(skill('stage'), 'utf8')).toBe('stage edited by hand');
    expect(readFileSync(skill('memory'), 'utf8')).toBe('memory edited by hand');
  });

  test('the old metro-orchestrator skill becomes metro: a copy metro shipped gets the new rules, an edited one keeps its edits', () => {
    placeSkill('metro-orchestrator', SHIPPED_BEFORE);
    expect(ensureClaudeSetup(deps())).toMatchObject({ skill: 'updated', stage: 'written' });
    expect(readFileSync(skill('metro'), 'utf8')).toBe(readFileSync(join(PLUGIN, 'METRO.md'), 'utf8'));
    expect(existsSync(join(dir, 'claude', 'skills', 'metro-orchestrator'))).toBe(false);
    rmSync(join(dir, 'claude', 'skills', 'metro'), { recursive: true });
    placeSkill('metro-orchestrator', '---\nname: metro-orchestrator\ndescription: mine\n---\nAnswer in French.\n');
    expect(ensureClaudeSetup(deps()).skill).toBe('present');
    expect(readFileSync(skill('metro'), 'utf8')).toBe('---\nname: metro\ndescription: mine\n---\nAnswer in French.\n');
    expect(existsSync(join(dir, 'claude', 'skills', 'metro-orchestrator'))).toBe(false);
  });

  test('beside an existing metro skill, an old copy metro shipped is removed and an edited one is left alone', () => {
    placeSkill('metro', 'my metro rules');
    placeSkill('metro-orchestrator', SHIPPED_BEFORE);
    ensureClaudeSetup(deps());
    expect(existsSync(join(dir, 'claude', 'skills', 'metro-orchestrator'))).toBe(false);
    expect(readFileSync(skill('metro'), 'utf8')).toBe('my metro rules');
    placeSkill('metro-orchestrator', 'my old rules');
    ensureClaudeSetup(deps());
    expect(readFileSync(skill('metro-orchestrator'), 'utf8')).toBe('my old rules');
    expect(readFileSync(skill('metro'), 'utf8')).toBe('my metro rules');
  });

  test('a copy metro itself wrote is refreshed when the rules move on, and a copy someone edited never is', () => {
    const path = join(dir, 'claude', 'rules.md');
    const older = 'the rules metro shipped last time\n';
    const prior = new Set([createHash('sha256').update(older).digest('hex')]);
    expect(placeFile(path, older, prior)).toBe('written');
    expect(placeFile(path, older, prior)).toBe('present');
    expect(placeFile(path, 'the rules metro ships now\n', prior)).toBe('updated');
    expect(readFileSync(path, 'utf8')).toBe('the rules metro ships now\n');
    writeFileSync(path, 'what the person wrote instead\n');
    expect(placeFile(path, 'the rules metro ships now\n', prior)).toBe('present');
    expect(readFileSync(path, 'utf8')).toBe('what the person wrote instead\n');
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
    expect(claudeSetupStatus(deps())).toEqual({
      privacy: false,
      permissionMode: 'auto',
      runner: 'cli',
      runnerAllowed: false,
      sdkOnLogin: false,
      systemPrompt: '',
      liveEvents: true,
      memoryRoutine: true,
      memoryJob: expect.any(Object),
      guard: 'plugin',
      worker: true,
      skill: true,
      stage: true,
      memory: true,
      privacyApplied: false,
      retentionDays: 7,
    });
  });

  test('missing skill sources are reported, not thrown', () => {
    const report = ensureClaudeSetup({ ...deps(), plugin: join(dir, 'nowhere') });
    expect(report).toMatchObject({ skill: 'missing', stage: 'missing', memory: 'missing' });
    expect(existsSync(join(dir, 'claude', 'skills'))).toBe(false);
  });
});

describe('the setup over the API', () => {
  let server: Server;
  let base = '';

  beforeEach(async () => {
    server = createServer((req, res) => {
      const ok = handleClaudeRequest(req, res, {
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

  const call = async (method: string, body?: unknown, authorization?: string): Promise<Response> =>
    fetch(`${base}/api/claude/setup`, {
      method,
      headers: { authorization: authorization ?? (await auth(OWNER)), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const route = (connection: ReturnType<typeof makeConnection>): void => {
    writeFileSync(join(dir, 'agents', 'model.json'), JSON.stringify(configOf(connection.provider, [connection])));
  };
  interface Runner {
    runner: string;
    runnerAllowed: boolean;
    sdkOnLogin: boolean;
  }
  const runnerOf = async (res: Response | Promise<Response>): Promise<Runner> => (await (await res).json()) as Runner;
  const refusal = async (res: Response | Promise<Response>): Promise<{ status: number; error: string }> => {
    const done = await res;
    return { status: done.status, error: ((await done.json()) as { error: string }).error };
  };

  test('the owner reads the status and flips privacy, which rewrites the settings at once', async () => {
    expect((await (await call('GET')).json()) as unknown).toMatchObject({ privacy: true, worker: false, skill: false, stage: false, privacyApplied: false });
    const off = (await (await call('POST', { privacy: false })).json()) as { privacy: boolean; worker: boolean; skill: boolean; stage: boolean; privacyApplied: boolean };
    expect(off).toMatchObject({ privacy: false, worker: true, skill: true, stage: true, privacyApplied: false });
    const on = (await (await call('POST', { privacy: true })).json()) as { privacyApplied: boolean; retentionDays: number };
    expect(on).toMatchObject({ privacyApplied: true, retentionDays: RETENTION_DAYS });
    expect((await call('POST', { privacy: 'yes' })).status).toBe(400);
  });
});

describe("Claude Code's model allowlist follows the Model page", () => {
  const cfg = (provider: 'anthropic' | 'openrouter', over: Record<string, unknown> = {}): ReturnType<typeof readModelConfig> =>
    configOf(provider, [makeConnection(provider, over)]) as ReturnType<typeof readModelConfig>;

  test('a non-Anthropic route becomes the only model Claude Code offers, and Anthropic clears it again', () => {
    const openrouter = cfg('openrouter', { apiKey: 'k', model: 'anthropic/claude-sonnet-5', zdr: true });
    expect(routeOf(openrouter)).toBe('openrouter:anthropic/claude-sonnet-5');
    writeFileSync(join(dir, 'claude', 'settings.json'), JSON.stringify({ env: { MY_VAR: 'x' } }));
    expect(syncAvailableModels(openrouter, deps())).toBe('written');
    expect(settings()).toEqual({ env: { MY_VAR: 'x' }, availableModels: ['openrouter:anthropic/claude-sonnet-5'], enforceAvailableModels: true });
    expect(syncAvailableModels(openrouter, deps())).toBe('unchanged');
    expect(syncAvailableModels(cfg('anthropic'), deps())).toBe('written');
    expect(settings()).toEqual({ env: { MY_VAR: 'x' } });
  });

  test('an allowlist the user wrote themselves is left alone when the route is Anthropic', () => {
    writeFileSync(join(dir, 'claude', 'settings.json'), JSON.stringify({ availableModels: ['claude-opus-5'] }));
    expect(syncAvailableModels(cfg('anthropic'), deps())).toBe('unchanged');
    expect(settings()).toEqual({ availableModels: ['claude-opus-5'] });
  });
});

describe('the permission mode of the session', () => {
  let server: Server;
  let base = '';
  beforeEach(async () => {
    server = createServer((req, res) => {
      const ok = handleClaudeRequest(req, res, { setup: deps(), session: { tmux: join(dir, 'no-tmux-here') } });
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
  const call = async (method: string, body?: unknown, authorization?: string): Promise<Response> =>
    fetch(`${base}/api/claude/setup`, {
      method,
      headers: { authorization: authorization ?? (await auth(OWNER)), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const route = (connection: ReturnType<typeof makeConnection>): void => {
    writeFileSync(join(dir, 'agents', 'model.json'), JSON.stringify(configOf(connection.provider, [connection])));
  };
  interface Runner {
    runner: string;
    runnerAllowed: boolean;
    sdkOnLogin: boolean;
  }
  const runnerOf = async (res: Response | Promise<Response>): Promise<Runner> => (await (await res).json()) as Runner;
  const refusal = async (res: Response | Promise<Response>): Promise<{ status: number; error: string }> => {
    const done = await res;
    return { status: done.status, error: ((await done.json()) as { error: string }).error };
  };

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

  test('the runner is the Claude Code session until switched to the Agent SDK on an API-key route, is kept with the setup, and anything else is refused', async () => {
    route(makeConnection('anthropic', { apiKey: 'sk-ant-test' }));
    expect(await runnerOf(call('GET'))).toMatchObject({ runner: 'cli', runnerAllowed: true, sdkOnLogin: false });
    expect((await runnerOf(call('POST', { runner: 'sdk' }))).runner).toBe('sdk');
    expect((JSON.parse(readFileSync(join(dir, 'agents', 'claude-setup.json'), 'utf8')) as { runner: string }).runner).toBe('sdk');
    expect((await call('POST', { runner: 'codex' })).status).toBe(400);
    expect((await runnerOf(call('POST', { runner: 'cli' }))).runner).toBe('cli');
  });

  test('the Agent SDK runner is refused on a Claude login, a keyless Anthropic connection, Codex and Gemini, and taken with Bedrock or OpenRouter keys', async () => {
    const refused = await refusal(call('POST', { runner: 'sdk' }));
    expect(refused.status).toBe(403);
    expect(refused.error).toContain('needs an API key');
    expect((await runnerOf(call('GET'))).runnerAllowed).toBe(false);
    for (const login of [makeConnection('anthropic'), makeConnection('codex', { model: 'gpt-6' }), makeConnection('gemini', { model: 'gemini-3' })]) {
      route(login);
      expect((await call('POST', { runner: 'sdk' })).status).toBe(403);
    }
    expect((await runnerOf(call('GET'))).runner).toBe('cli');
    for (const keyed of [makeConnection('bedrock', { apiKey: 'br-key', region: 'us-east-1' }), makeConnection('openrouter', { apiKey: 'or-key', model: 'anthropic/claude-sonnet-5' })]) {
      route(keyed);
      expect(await runnerOf(call('POST', { runner: 'sdk' }))).toMatchObject({ runner: 'sdk', runnerAllowed: true });
      await call('POST', { runner: 'cli' });
    }
  });

  test('every fallback model needs an API key too: one on a Claude login, Codex or Gemini keeps the Agent SDK runner off', async () => {
    const first = makeConnection('openrouter', { apiKey: 'or-key', model: 'anthropic/claude-sonnet-5' });
    const fallingBackTo = (fallback: ReturnType<typeof makeConnection>): void => {
      const cfg = configOf('openrouter', [first, fallback]);
      writeFileSync(join(dir, 'agents', 'model.json'), JSON.stringify({ ...cfg, fallbacks: [{ connection: fallback.id, model: fallback.model === '' ? 'claude-opus-5-5' : fallback.model }] }));
    };
    fallingBackTo(makeConnection('anthropic', { apiKey: 'sk-ant-test', model: 'claude-opus-5-5' }));
    expect(await runnerOf(call('POST', { runner: 'sdk' }))).toMatchObject({ runner: 'sdk', runnerAllowed: true });
    await call('POST', { runner: 'cli' });
    for (const login of [makeConnection('anthropic'), makeConnection('codex', { model: 'gpt-6' }), makeConnection('gemini', { model: 'gemini-3' })]) {
      fallingBackTo(login);
      const refused = await refusal(call('POST', { runner: 'sdk' }));
      expect(refused.status).toBe(403);
      expect(refused.error).toContain('each fallback');
      expect(await runnerOf(call('GET'))).toMatchObject({ runner: 'cli', runnerAllowed: false });
    }
  });

  test('only the Metro operator allows the Agent SDK on the Claude login, and taking it back puts the agent on Claude Code', async () => {
    const admin = await refusal(call('POST', { sdkOnLogin: true }));
    expect(admin).toEqual({ status: 403, error: 'only the Metro operator can allow the Agent SDK on a Claude login' });
    const operator = await operatorAuth(OWNER);
    expect(await runnerOf(call('POST', { sdkOnLogin: true }, operator))).toMatchObject({ sdkOnLogin: true, runnerAllowed: true, runner: 'cli' });
    expect(await runnerOf(call('POST', { runner: 'sdk' }))).toMatchObject({ runner: 'sdk', runnerAllowed: true });
    expect((await call('POST', { sdkOnLogin: false })).status).toBe(403);
    expect(await runnerOf(call('POST', { sdkOnLogin: false }, operator))).toEqual(expect.objectContaining({ sdkOnLogin: false, runnerAllowed: false, runner: 'cli' }));
    expect(await runnerOf(call('POST', { sdkOnLogin: true, runner: 'sdk' }, operator))).toMatchObject({ sdkOnLogin: true, runner: 'sdk' });
  });

  test('a system prompt is kept as a file the CLI appends, empty removes it, and a non-text or huge one is refused', async () => {
    const before = (await (await call('GET')).json()) as { systemPrompt: string };
    expect(before.systemPrompt).toBe('');
    const set = (await (await call('POST', { systemPrompt: '  You are Lisa, the ops agent.\nBe brief.  ' })).json()) as { systemPrompt: string };
    expect(set.systemPrompt).toBe('You are Lisa, the ops agent.\nBe brief.');
    expect(readFileSync(join(dir, 'agents', 'system-prompt.md'), 'utf8')).toBe('You are Lisa, the ops agent.\nBe brief.\n');
    const cleared = (await (await call('POST', { systemPrompt: '' })).json()) as { systemPrompt: string };
    expect(cleared.systemPrompt).toBe('');
    expect(existsSync(join(dir, 'agents', 'system-prompt.md'))).toBe(false);
    expect((await call('POST', { systemPrompt: 7 })).status).toBe(400);
    expect((await call('POST', { systemPrompt: 'x'.repeat(64 * 1024 + 1) })).status).toBe(400);
  });
});

describe('live messages to the session', () => {
  let server: Server;
  let base = '';
  let told: boolean[] = [];
  beforeEach(async () => {
    told = [];
    server = createServer((req, res) => {
      const ok = handleClaudeRequest(req, res, {
        setup: deps(),
        session: { tmux: join(dir, 'no-tmux-here') },
        liveEvents: (on) => {
          told.push(on);
        },
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
  const call = async (method: string, body?: unknown, authorization?: string): Promise<Response> =>
    fetch(`${base}/api/claude/setup`, {
      method,
      headers: { authorization: authorization ?? (await auth(OWNER)), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const route = (connection: ReturnType<typeof makeConnection>): void => {
    writeFileSync(join(dir, 'agents', 'model.json'), JSON.stringify(configOf(connection.provider, [connection])));
  };
  interface Runner {
    runner: string;
    runnerAllowed: boolean;
    sdkOnLogin: boolean;
  }
  const runnerOf = async (res: Response | Promise<Response>): Promise<Runner> => (await (await res).json()) as Runner;
  const refusal = async (res: Response | Promise<Response>): Promise<{ status: number; error: string }> => {
    const done = await res;
    return { status: done.status, error: ((await done.json()) as { error: string }).error };
  };
  const state = (): Record<string, unknown> => JSON.parse(readFileSync(join(dir, 'agents', 'claude-setup.json'), 'utf8')) as Record<string, unknown>;

  test('are on until switched off, the switch is kept with the setup and reaches the daemon at once, and a non-boolean is refused', async () => {
    expect(((await (await call('GET')).json()) as { liveEvents: boolean }).liveEvents).toBe(true);
    const off = (await (await call('POST', { liveEvents: false })).json()) as { liveEvents: boolean; permissionMode: string };
    expect(off).toMatchObject({ liveEvents: false, permissionMode: 'auto' });
    expect(state().liveEvents).toBe(false);
    expect(told).toEqual([false]);
    await call('POST', { permissionMode: 'bypass' });
    expect(((await (await call('GET')).json()) as { liveEvents: boolean }).liveEvents).toBe(false);
    const on = (await (await call('POST', { liveEvents: true })).json()) as { liveEvents: boolean; permissionMode: string };
    expect(on).toMatchObject({ liveEvents: true, permissionMode: 'bypass' });
    expect(told).toEqual([false, true]);
    expect((await call('POST', { liveEvents: 'off' })).status).toBe(400);
    expect(told).toEqual([false, true]);
  });
});

describe('the daily memory routine switch', () => {
  let server: Server;
  let base = '';
  let told: boolean[] = [];
  beforeEach(async () => {
    told = [];
    server = createServer((req, res) => {
      const ok = handleClaudeRequest(req, res, {
        setup: deps(),
        session: { tmux: join(dir, 'no-tmux-here') },
        memoryJob: (on) => {
          told.push(on);
        },
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
  const call = async (method: string, body?: unknown, authorization?: string): Promise<Response> =>
    fetch(`${base}/api/claude/setup`, {
      method,
      headers: { authorization: authorization ?? (await auth(OWNER)), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const route = (connection: ReturnType<typeof makeConnection>): void => {
    writeFileSync(join(dir, 'agents', 'model.json'), JSON.stringify(configOf(connection.provider, [connection])));
  };
  interface Runner {
    runner: string;
    runnerAllowed: boolean;
    sdkOnLogin: boolean;
  }
  const runnerOf = async (res: Response | Promise<Response>): Promise<Runner> => (await (await res).json()) as Runner;
  const refusal = async (res: Response | Promise<Response>): Promise<{ status: number; error: string }> => {
    const done = await res;
    return { status: done.status, error: ((await done.json()) as { error: string }).error };
  };
  const state = (): Record<string, unknown> => JSON.parse(readFileSync(join(dir, 'agents', 'claude-setup.json'), 'utf8')) as Record<string, unknown>;

  test('is on until switched off, is kept with the setup, sets the job up again at once, and a non-boolean is refused', async () => {
    expect(((await (await call('GET')).json()) as { memoryRoutine: boolean }).memoryRoutine).toBe(true);
    const off = (await (await call('POST', { memoryRoutine: false })).json()) as { memoryRoutine: boolean; liveEvents: boolean };
    expect(off).toMatchObject({ memoryRoutine: false, liveEvents: true });
    expect(state().memoryRoutine).toBe(false);
    expect(told).toEqual([false]);
    const on = (await (await call('POST', { memoryRoutine: true })).json()) as { memoryRoutine: boolean };
    expect(on.memoryRoutine).toBe(true);
    expect(told).toEqual([false, true]);
    expect((await call('POST', { memoryRoutine: 'off' })).status).toBe(400);
    expect(told).toEqual([false, true]);
  });
});
