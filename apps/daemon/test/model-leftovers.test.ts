import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '@metro-labs/core/log';
import { removeModelLeftovers } from '../src/gateway/model-leftovers.ts';

const LEFTOVERS = ['chatgpt-host.json', 'chatgpt-host.json.tmp-4242'];

const KEPT = [
  'agent.json',
  'model.json',
  'model.json.tmp-12',
  'claude-setup.json',
  'voice.json',
  'chatgpt-host.json.bak',
  'chatgpt-host.json.tmp-abc',
  'old-chatgpt-host.json',
  'chatgpt-host.jsonx',
];

let root = '';
let dir = '';

const names = (): string[] => readdirSync(dir).sort();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metro-model-leftovers-'));
  dir = join(root, 'agents');
  mkdirSync(dir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the boot cleanup of the old model files', () => {
  test('the ChatGPT host id the box kept for the old Codex sign-in goes, with its temp file, in one info line', () => {
    for (const name of LEFTOVERS) writeFileSync(join(dir, name), '{"hostId":"urn:uuid:x"}');
    const info = spyOn(log, 'info');
    try {
      expect(removeModelLeftovers(dir)).toBe(LEFTOVERS.length);
      expect(names()).toEqual([]);
      const lines = info.mock.calls.filter((call) => String(call[1]).startsWith('org-models: removed'));
      expect(lines).toEqual([[{ removed: LEFTOVERS.length }, 'org-models: removed the files of the old model setup']]);
    } finally {
      info.mockRestore();
    }
  });

  test('every other file stays, byte for byte', () => {
    for (const name of [...LEFTOVERS, ...KEPT]) writeFileSync(join(dir, name), `content of ${name}`);
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'chatgpt-host.json'), 'nested');
    expect(removeModelLeftovers(dir)).toBe(LEFTOVERS.length);
    expect(names()).toEqual([...KEPT, 'nested'].sort());
    for (const name of KEPT) expect(readFileSync(join(dir, name), 'utf8')).toBe(`content of ${name}`);
    expect(readFileSync(join(dir, 'nested', 'chatgpt-host.json'), 'utf8')).toBe('nested');
  });

  test('a symlink or a folder with a leftover name is left alone, and its target is never touched', () => {
    const target = join(root, 'elsewhere.json');
    writeFileSync(target, 'not metro');
    symlinkSync(target, join(dir, 'chatgpt-host.json'));
    mkdirSync(join(dir, 'chatgpt-host.json.tmp-7'));
    writeFileSync(join(dir, 'chatgpt-host.json.tmp-8'), '{}');
    const warn = spyOn(log, 'warn');
    try {
      expect(removeModelLeftovers(dir)).toBe(1);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
    expect(lstatSync(join(dir, 'chatgpt-host.json')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dir, 'chatgpt-host.json.tmp-7')).isDirectory()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('not metro');
    expect(existsSync(join(dir, 'chatgpt-host.json.tmp-8'))).toBe(false);
  });

  test('a missing folder is fine and logs no warning, and running it again removes nothing more', () => {
    const warn = spyOn(log, 'warn');
    try {
      expect(removeModelLeftovers(join(root, 'absent'))).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    for (const name of [...LEFTOVERS, ...KEPT]) writeFileSync(join(dir, name), '{}');
    expect(removeModelLeftovers(dir)).toBe(LEFTOVERS.length);
    const after = names();
    expect(removeModelLeftovers(dir)).toBe(0);
    expect(names()).toEqual(after);
  });
});
