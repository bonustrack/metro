import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { agentUser, asUser, forgetAgentUser, wantedAgentUser, type AgentUser, type UserHost } from '../src/agent-user/user.ts';
import { moveHome, receiveHomeFile, removeHome, writeHomeText } from '../src/agent-user/home-fs.ts';
import { viewFiles } from '../src/agent-user/view.ts';
import { sessionBlocked } from '../src/claude/session.ts';

const AGENT: AgentUser = { name: 'agent', uid: 1001, gid: 1001, home: '/home/agent' };
const host = (over: Partial<UserHost> = {}): UserHost => ({ platform: 'linux', uid: 0, lookup: (name) => (name === 'agent' ? AGENT : null), ...over });

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-agent-user-'));
  forgetAgentUser();
});

afterEach(() => {
  forgetAgentUser();
});

const setting = (value: unknown): void => {
  writeFileSync(join(dir, 'agent-user.json'), JSON.stringify(value));
};

describe('which user Claude Code runs as', () => {
  test('off unless the box asks for it; a bad name or root is refused', () => {
    expect(wantedAgentUser(dir)).toBeNull();
    setting({});
    expect(wantedAgentUser(dir)).toBe('agent');
    setting({ user: 'claude-bot' });
    expect(wantedAgentUser(dir)).toBe('claude-bot');
    for (const bad of [{ user: 'root' }, { user: 'Bad Name' }, { user: '../x' }, { enabled: false }]) {
      setting(bad);
      expect(wantedAgentUser(dir)).toBeNull();
    }
  });

  test('only on Linux, only for a daemon running as root, and only once the user exists', () => {
    setting({});
    expect(agentUser(dir, host())).toEqual(AGENT);
    forgetAgentUser();
    expect(agentUser(dir, host({ platform: 'darwin' }))).toBeNull();
    expect(agentUser(dir, host({ uid: 501 }))).toBeNull();
    expect(agentUser(dir, host({ lookup: () => null }))).toBeNull();
  });

  test('a command runs through runuser with a clean environment of its own', () => {
    expect(asUser(null, 'tmux', ['-V'])).toEqual(['tmux', ['-V']]);
    const [file, args] = asUser(AGENT, 'tmux', ['has-session', '-t', 'metro'], { EXTRA: '1' });
    expect(file).toBe('runuser');
    expect(args.slice(0, 5)).toEqual(['-u', 'agent', '--', 'env', '-i']);
    expect(args).toContain('HOME=/home/agent');
    expect(args).toContain('USER=agent');
    expect(args).toContain('EXTRA=1');
    expect(args.find((a) => a.startsWith('PATH='))).toStartWith('PATH=/home/agent/.local/bin:');
    expect(args.slice(-4)).toEqual(['tmux', 'has-session', '-t', 'metro']);
  });

  test('a Claude session set to run as its own user stays stopped where that user cannot exist', () => {
    writeFileSync(join(dir, 'agent.json'), JSON.stringify({ version: 1, id: 'agent000001', key: 'k'.repeat(32), stations: [] }));
    setting({});
    expect(sessionBlocked({ agents: dir, tmux: 'true', signedIn: () => true })).toContain('not ready');
  });
});

describe('the Metro files the agent may read', () => {
  test('carry the key and the route, never a channel credential or a provider key', () => {
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({ version: 1, id: 'agent000001', key: 'secret-agent-key-0123456789', stations: [{ station: 'outlook', id: 'o1', config: { refreshToken: 'rt-SECRET' } }] }),
    );
    writeFileSync(join(dir, 'model.json'), JSON.stringify({ version: 2, route: 'c1', connections: [{ id: 'c1', provider: 'openrouter', model: 'x/y', apiKey: 'sk-SECRET', label: 'OpenRouter' }] }));
    writeFileSync(join(dir, 'policy.json'), '{"version":1}');
    const files = viewFiles(dir);
    const all = [...files.values()].join('\n');
    expect(all).not.toContain('SECRET');
    expect(JSON.parse(files.get('agent.json') ?? '')).toEqual({ version: 1, id: 'agent000001', key: 'secret-agent-key-0123456789' });
    expect(JSON.parse(files.get('model.json') ?? '')).toEqual({ version: 2, route: 'c1', connections: [{ id: 'c1', provider: 'openrouter', model: 'x/y' }] });
    expect(files.get('policy.json')).toBe('{"version":1}');
    expect(files.get('system-prompt.md')).toBeNull();
  });
});

describe('writing into the home Claude Code uses, when no agent user is set', () => {
  test('writes, stamps, moves, streams and removes like plain file calls', async () => {
    const path = join(dir, 'a', 'b', 'note.md');
    writeHomeText(path, 'hi', 0o640, new Date('2026-01-02T03:04:05.000Z'), null);
    expect(readFileSync(path, 'utf8')).toBe('hi');
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(statSync(path).mtime.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    moveHome(path, join(dir, 'moved.md'), null);
    await receiveHomeFile(join(dir, 'x', 'big.jsonl'), Readable.from([Buffer.from('{"a":1}\n')]), 0o600, null);
    expect(readFileSync(join(dir, 'x', 'big.jsonl'), 'utf8')).toBe('{"a":1}\n');
    removeHome(join(dir, 'a'), true, null);
    expect(existsSync(join(dir, 'a'))).toBe(false);
    expect(existsSync(join(dir, 'moved.md'))).toBe(true);
  });
});
