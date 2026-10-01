import { afterAll, describe, expect, test } from 'bun:test';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapesHome } from '../src/agent-user/agent-fs.ts';
import type { AgentUser } from '../src/agent-user/user.ts';
import { curlArgs } from '../src/stations/attach-resolve.ts';

const root = mkdtempSync(join(tmpdir(), 'metro-boundary-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a read of the agent home never lands on a metro file', () => {
  const home = join(root, 'agent');
  const metro = join(root, 'metro');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(metro, { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), '{}');
  writeFileSync(join(metro, 'private.json'), '{}');
  symlinkSync(join(metro, 'private.json'), join(home, '.claude.json'));
  symlinkSync(metro, join(home, 'linked'));
  const user: AgentUser = { name: 'agent', uid: 1001, gid: 1001, home };

  test('a file that really lives in the home is read by metro directly', () => {
    expect(escapesHome(join(home, '.claude', 'settings.json'), user)).toBe(false);
    expect(escapesHome(join(home, 'missing.json'), user)).toBe(false);
  });

  test('a link out of the home is caught by path and by the opened file', () => {
    expect(escapesHome(join(home, '.claude.json'), user)).toBe(true);
    expect(escapesHome(join(home, 'linked', 'private.json'), user)).toBe(true);
    const fd = openSync(join(home, '.claude.json'), 'r');
    try {
      expect(escapesHome(join(home, '.claude.json'), user, fd)).toBe(true);
    } finally {
      closeSync(fd);
    }
  });

  test('metro own files outside the agent home are not the agent home rule', () => {
    expect(escapesHome(join(metro, 'private.json'), user)).toBe(false);
  });
});

describe('an attachment url is fetched by curl as the agent', () => {
  test('the url is never read as an option and only http(s) is followed', () => {
    const args = curlArgs('-o/etc/x');
    expect(args.at(-1)).toBe('-o/etc/x');
    expect(args.at(-2)).toBe('--');
    expect(args).toContain('=http,https');
    expect(args[args.indexOf('--proto-redir') + 1]).toBe('=http,https');
    expect(args).toContain('--max-filesize');
  });
});
