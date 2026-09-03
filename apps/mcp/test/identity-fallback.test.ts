import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selfLine, userSelf } from '../src/daemon/identity.ts';

const KEYS = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'METRO_USER_ID', 'METRO_FROM', 'PATH'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let emptyPath = '';

beforeEach(() => {
  emptyPath = mkdtempSync(join(tmpdir(), 'metro-nopath-'));
  process.env.CLAUDECODE = '1';
  process.env.CLAUDE_CODE_SESSION_ID = 'sess-1';
  delete process.env.METRO_USER_ID;
  delete process.env.METRO_FROM;
  process.env.PATH = emptyPath;
});

afterEach(() => {
  for (const k of KEYS)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  rmSync(emptyPath, { recursive: true, force: true });
});

describe('identity when Claude Code cannot answer', () => {
  test('inside a Claude Code session with no working claude binary, nothing throws', () => {
    expect(userSelf()).toBe('metro://user');
    expect(selfLine()).toBeNull();
  });

  test('an explicit METRO_USER_ID needs no claude binary at all', () => {
    process.env.METRO_USER_ID = 'org_abc';
    expect(userSelf()).toBe('metro://claude/user/org_abc');
    const line = selfLine() ?? '';
    expect(line).toStartWith('metro://claude/');
    expect(line).toContain('org_abc');
    expect(line).toContain('sess-1');
  });

  test('outside Claude Code there is no self line and no lookup', () => {
    delete process.env.CLAUDECODE;
    expect(userSelf()).toBe('metro://user');
    expect(selfLine()).toBeNull();
  });
});
