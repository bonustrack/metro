import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '@metro-labs/core/log';
import { removePolicyLeftovers } from '../src/policy/leftovers.ts';

const LEFTOVERS = ['policy.json', 'policy.json.tmp-4242', 'policy.json.tmp-7'];

const KEPT = [
  'agent.json',
  'agent-key.json',
  'claude-setup.json',
  'mcp-approvals.json',
  'mcp-token',
  'system-prompt.md',
  'voice.json',
  'policy.json.bak',
  'policy.json.tmp-abc',
  'policy.json.tmp',
  'old-policy.json',
  'policy.jsonl',
];

let root = '';
let dir = '';

const names = (): string[] => readdirSync(dir).sort();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metro-policy-leftovers-'));
  dir = join(root, 'agents');
  mkdirSync(dir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the boot cleanup of the rules snapshot the guard hook used to read', () => {
  test('the snapshot goes with the temp files a crash could leave, and one line says how many', () => {
    for (const name of LEFTOVERS) writeFileSync(join(dir, name), '{"version":1}');
    const info = spyOn(log, 'info');
    try {
      expect(removePolicyLeftovers(dir)).toBe(LEFTOVERS.length);
      expect(names()).toEqual([]);
      expect(info.mock.calls.filter((call) => String(call[1]).startsWith('policy:'))).toEqual([
        [{ removed: LEFTOVERS.length }, 'policy: removed the rules snapshot the guard hook used to read'],
      ]);
    } finally {
      info.mockRestore();
    }
  });

  test('every other file stays, byte for byte, and so does a file of that name in a folder below', () => {
    for (const name of [...LEFTOVERS, ...KEPT]) writeFileSync(join(dir, name), `content of ${name}`);
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'policy.json'), 'nested');
    expect(removePolicyLeftovers(dir)).toBe(LEFTOVERS.length);
    expect(names()).toEqual([...KEPT, 'nested'].sort());
    for (const name of KEPT) expect(readFileSync(join(dir, name), 'utf8')).toBe(`content of ${name}`);
    expect(readFileSync(join(dir, 'nested', 'policy.json'), 'utf8')).toBe('nested');
  });

  test('a link or a folder with that name is left alone with a warning, and what a link points to is untouched', () => {
    const outside = join(root, 'outside.json');
    writeFileSync(outside, 'precious');
    symlinkSync(outside, join(dir, 'policy.json'));
    mkdirSync(join(dir, 'policy.json.tmp-12'));
    const warn = spyOn(log, 'warn');
    try {
      expect(removePolicyLeftovers(dir)).toBe(0);
      expect(warn.mock.calls.map((call) => call[1])).toEqual([
        'policy: left an old rules snapshot alone, it is not a regular file',
        'policy: left an old rules snapshot alone, it is not a regular file',
      ]);
    } finally {
      warn.mockRestore();
    }
    expect(lstatSync(join(dir, 'policy.json')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dir, 'policy.json.tmp-12')).isDirectory()).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('precious');
  });

  test('a missing folder, or a second run, removes nothing and never throws', () => {
    expect(removePolicyLeftovers(join(root, 'no-such-folder'))).toBe(0);
    writeFileSync(join(dir, 'policy.json'), '{}');
    expect(removePolicyLeftovers(dir)).toBe(1);
    expect(removePolicyLeftovers(dir)).toBe(0);
    expect(existsSync(join(dir, 'policy.json'))).toBe(false);
  });
});
