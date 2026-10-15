import { describe, expect, spyOn, test } from 'bun:test';
import { answerClaudeLogin, cancelClaudeLogin, claudeAvailable, pollClaudeLogin, startClaudeLogin, toSettingsFile } from '../src/api/claude.js';
import { controlClaudeSession, toClaudeSession } from '../src/api/claude-box.js';
import { clearAccount } from '../src/auth/account.js';
import { installTestAccount } from './account-fixture.js';

const activity = {
  pid: 123, runner: 'sdk', phase: 'working', sessionId: '12345678-1234-1234-1234-123456789abc',
  updatedAt: 1_800_000_000_000, pending: 2, workers: 3, approvals: 1, tools: ['Read'], lastError: null,
  mainPhase: 'working', mainStartedAt: null, activeTools: [], tasks: [], events: [],
};

describe('the optional SDK runtime status', () => {
  test('old daemons keep their safe defaults and have no runtime details', () => {
    expect(toClaudeSession({ running: true })).toEqual({
      name: 'metro', running: true, legacyRunner: false, autostart: true, blocked: null, lastStartedAt: null, lastError: null, activity: null,
    });
    expect(toClaudeSession({ running: true, runner: 'cli', channels: { registered: false } }).legacyRunner).toBe(true);
    expect(toClaudeSession({ running: false, activity: { phase: 'idle' } }).activity).toBeNull();
  });

  test('reads the shared runtime shape without retaining chat or tool arguments', () => {
    expect(toClaudeSession({ running: true, activity: { ...activity, toolArgs: { command: 'private' }, text: 'private' } }).activity).toEqual(activity);
    expect(toClaudeSession({ running: true, activity: { ...activity, phase: 'approval' } }).activity?.phase).toBe('approval');
  });
});

test('Start and Stop explicitly set autostart even for an older daemon', async () => {
  installTestAccount();
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(Response.json({ running: false })));
  try {
    await controlClaudeSession({ action: 'stop' });
    await controlClaudeSession({ action: 'start' });
    await controlClaudeSession({ autostart: false });
    expect(fetch.mock.calls.map((call) => call[1]?.body)).toEqual([
      '{"action":"stop","autostart":false}', '{"action":"start","autostart":true}', '{"autostart":false}',
    ]);
    expect(fetch.mock.calls.map((call) => call[1]?.method)).toEqual(['POST', 'POST', 'POST']);
  } finally {
    fetch.mockRestore();
    clearAccount();
  }
});

test('the Claude token sign-in starts with a plain POST on the box it names, and the token comes back on the answer that carries it', async () => {
  installTestAccount();
  const token = `sk-ant-oat01-${'k'.repeat(80)}`;
  const box = 'https://metro-abc123.example.ts.net';
  const answers = [{ id: 'run1', state: 'pending', url: 'https://claude.ai/oauth/authorize?x=1', output: '' }, { id: 'run1', state: 'pending', url: null, output: '' }, { id: 'run1', state: 'done', url: null, output: '[token]', error: null, token }, { available: true }, { ended: true }];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(Response.json(answers.shift())));
  try {
    expect(await startClaudeLogin(box)).toMatchObject({ id: 'run1', state: 'pending', url: 'https://claude.ai/oauth/authorize?x=1', token: null });
    expect(await answerClaudeLogin('run1', 'the-code', box)).toMatchObject({ state: 'pending', token: null });
    expect(await pollClaudeLogin('run1', box)).toMatchObject({ state: 'done', token });
    expect(await claudeAvailable(box)).toBe(true);
    await cancelClaudeLogin('run1', box);
    expect(fetch.mock.calls.map((call) => [String(call[0]), call[1]?.method])).toEqual([
      [`${box}/api/claude/login`, 'POST'], [`${box}/api/claude/login/run1`, 'POST'], [`${box}/api/claude/login/run1`, 'GET'], [`${box}/api/claude/login`, 'GET'], [`${box}/api/claude/login/run1`, 'DELETE'],
    ]);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe('{"text":"the-code"}');
  } finally {
    fetch.mockRestore();
    clearAccount();
  }
});

describe('the settings files a daemon lists', () => {
  test('a well-formed row keeps every field, a row with an unknown scope is dropped, and missing fields fall back', () => {
    const row = {
      id: 'user',
      scope: 'user',
      label: 'This machine',
      path: '/home/me/.claude/settings.json',
      exists: true,
      editable: true,
      text: '{"model":"opus"}',
      modifiedAt: '2026-09-08T09:00:00.000Z',
    };
    expect(toSettingsFile(row)).toEqual(row);
    expect(toSettingsFile({ ...row, scope: 'wat' })).toBeNull();
    expect(toSettingsFile({ id: 'user', scope: 'local' })).toBeNull();
    expect(toSettingsFile({ id: 'x', scope: 'project', path: '/p/.claude/settings.json' })).toEqual({
      id: 'x',
      scope: 'project',
      label: '/p/.claude/settings.json',
      path: '/p/.claude/settings.json',
      exists: false,
      editable: false,
      text: '',
      modifiedAt: null,
    });
  });
});

describe('the project a box page shows', () => {
  test('is the most recently active one, else the first, else none', async () => {
    const { pickHomeProject } = await import('../src/api/claude.js');
    const older = { id: '-root', cwd: '/root', sessions: 3, lastActiveAt: '2026-09-01T00:00:00.000Z', hasMemory: true };
    const newer = { id: '-root-suzy', cwd: '/root/suzy', sessions: 1, lastActiveAt: '2026-09-17T00:00:00.000Z', hasMemory: false };
    const never = { id: '-tmp', cwd: '/tmp', sessions: 0, lastActiveAt: null, hasMemory: false };
    expect(pickHomeProject([older, newer, never])).toBe('-root-suzy');
    expect(pickHomeProject([never])).toBe('-tmp');
    expect(pickHomeProject([])).toBeNull();
  });
});
