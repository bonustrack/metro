import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '@metro-labs/core/log';
import { claudeLoginsDir, removeModelLeftovers } from '../src/gateway/model-leftovers.ts';

const LEFTOVERS = ['chatgpt-host.json', 'chatgpt-host.json.tmp-4242', 'model.json', 'model.json.tmp-12'];

const KEPT = [
  'agent.json',
  'claude-setup.json',
  'voice.json',
  'chatgpt-host.json.bak',
  'chatgpt-host.json.tmp-abc',
  'old-chatgpt-host.json',
  'chatgpt-host.jsonx',
  'model.json.bak',
  'old-model.json',
  'model.jsonx',
];

let root = '';
let dir = '';
let logins = '';

const names = (): string[] => readdirSync(dir).sort();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metro-model-leftovers-'));
  dir = join(root, 'agents');
  logins = join(root, 'home', '.metro', 'claude-logins');
  mkdirSync(dir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the boot cleanup of the old model files', () => {
  test('the old model.json, the ChatGPT host id and their temp files go, in one info line', () => {
    for (const name of LEFTOVERS) writeFileSync(join(dir, name), '{"version":3,"claude":[]}');
    const info = spyOn(log, 'info');
    try {
      expect(removeModelLeftovers(dir, null)).toBe(LEFTOVERS.length);
      expect(names()).toEqual([]);
      const lines = info.mock.calls.filter((call) => String(call[1]).startsWith('org-models: removed'));
      expect(lines).toEqual([[{ removed: LEFTOVERS.length }, 'org-models: removed the files of the old model setup']]);
    } finally {
      info.mockRestore();
    }
  });

  test('the folder of the old Claude logins in the agent home goes with everything in it, and nothing next to it', () => {
    mkdirSync(join(logins, 'Login123456'), { recursive: true });
    writeFileSync(join(logins, 'Login123456', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"old"}}');
    mkdirSync(join(logins, 'Login123456.old-Other123456'));
    writeFileSync(join(root, 'home', '.metro', 'agent-session.json'), '{}');
    expect(removeModelLeftovers(dir, logins)).toBe(1);
    expect(existsSync(logins)).toBe(false);
    expect(readdirSync(join(root, 'home', '.metro'))).toEqual(['agent-session.json']);
    expect(removeModelLeftovers(dir, logins)).toBe(0);
  });

  test('without an agent user the folder is the one the old logins used, in the daemon home', () => {
    expect(claudeLoginsDir()).toBe(join(homedir(), '.metro', 'claude-logins'));
    expect(removeModelLeftovers(dir, null)).toBe(0);
  });

  test('every other file stays, byte for byte', () => {
    for (const name of [...LEFTOVERS, ...KEPT]) writeFileSync(join(dir, name), `content of ${name}`);
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'model.json'), 'nested');
    expect(removeModelLeftovers(dir, null)).toBe(LEFTOVERS.length);
    expect(names()).toEqual([...KEPT, 'nested'].sort());
    for (const name of KEPT) expect(readFileSync(join(dir, name), 'utf8')).toBe(`content of ${name}`);
    expect(readFileSync(join(dir, 'nested', 'model.json'), 'utf8')).toBe('nested');
  });

  test('a symlink or a folder with a leftover name is left alone, and its target is never touched', () => {
    const target = join(root, 'elsewhere.json');
    writeFileSync(target, 'not metro');
    symlinkSync(target, join(dir, 'model.json'));
    mkdirSync(join(dir, 'chatgpt-host.json.tmp-7'));
    writeFileSync(join(dir, 'chatgpt-host.json.tmp-8'), '{}');
    const warn = spyOn(log, 'warn');
    try {
      expect(removeModelLeftovers(dir, null)).toBe(1);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
    expect(lstatSync(join(dir, 'model.json')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dir, 'chatgpt-host.json.tmp-7')).isDirectory()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('not metro');
    expect(existsSync(join(dir, 'chatgpt-host.json.tmp-8'))).toBe(false);
  });

  test('a missing folder is fine and logs no warning, and running it again removes nothing more', () => {
    const warn = spyOn(log, 'warn');
    try {
      expect(removeModelLeftovers(join(root, 'absent'), join(root, 'absent-logins'))).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    for (const name of [...LEFTOVERS, ...KEPT]) writeFileSync(join(dir, name), '{}');
    expect(removeModelLeftovers(dir, null)).toBe(LEFTOVERS.length);
    const after = names();
    expect(removeModelLeftovers(dir, null)).toBe(0);
    expect(names()).toEqual(after);
  });
});
