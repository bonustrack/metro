import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '@metro-labs/core/log';
import { removeConnectorLeftovers } from '../src/connectors/leftovers.ts';

const LEFTOVERS = [
  'connectors.json',
  'connector-migrations.json',
  'connector-migrations.initialized',
  'connector-migration-operations-src00000001.json',
  'connector-migration-operations-src00000001.json.initialized',
  'connector-migration-operations-Z9_-abcdefg.json',
  'connector-server-keys.json',
  'connector-server-keys.initialized',
  'org-connector-sync.json',
  'connectors.json.tmp-4242',
  'connector-server-keys.json.tmp-7',
  'connector-server-keys.initialized.tmp-7',
  'org-connector-sync.json.tmp-1',
  'connector-migration-operations-src00000001.json.tmp-31',
  'connector-migrations.json.0123456789abcdef01234567.tmp',
];

const KEPT = [
  'agent.json',
  'agent-key.json',
  'agent-key.pending.json',
  'box-key.json',
  'mcp-token',
  'mcp-token.json',
  'mcp-approvals.json',
  'policy.json',
  'policy.json.tmp-12',
  'connectors.json.bak',
  'connectors.json.tmp-abc',
  'old-connectors.json',
  'connector-migrations.json.tmp',
  'connector-migrations.json.0123.tmp',
  'connector-migrations.initialized.tmp-3',
  'connector-migration-operations-short.json',
  'connector-migration-operations-src00000001.json.bak',
  'connector-migration-operations-_src0000001.json',
];

let root = '';
let dir = '';

const names = (): string[] => readdirSync(dir).sort();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metro-connector-leftovers-'));
  dir = join(root, 'agents');
  mkdirSync(dir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the boot cleanup of the old connector files', () => {
  test('every file the old connector path wrote goes, with its markers and temp files', () => {
    for (const name of LEFTOVERS) writeFileSync(join(dir, name), '{}');
    const info = spyOn(log, 'info');
    try {
      expect(removeConnectorLeftovers(dir)).toBe(LEFTOVERS.length);
      expect(names()).toEqual([]);
      const lines = info.mock.calls.filter((call) => String(call[1]).startsWith('connectors: removed'));
      expect(lines).toEqual([[{ removed: LEFTOVERS.length }, 'connectors: removed the files of the old connector path']]);
    } finally {
      info.mockRestore();
    }
  });

  test('every other file stays, byte for byte', () => {
    for (const name of [...LEFTOVERS, ...KEPT]) writeFileSync(join(dir, name), `content of ${name}`);
    mkdirSync(join(dir, 'connectors'));
    writeFileSync(join(dir, 'connectors', 'connectors.json'), 'nested');
    expect(removeConnectorLeftovers(dir)).toBe(LEFTOVERS.length);
    expect(names()).toEqual([...KEPT, 'connectors'].sort());
    for (const name of KEPT) expect(readFileSync(join(dir, name), 'utf8')).toBe(`content of ${name}`);
    expect(readFileSync(join(dir, 'connectors', 'connectors.json'), 'utf8')).toBe('nested');
  });

  test('a symlink or a folder with a leftover name is left alone, and its target is never touched', () => {
    const target = join(root, 'elsewhere.json');
    writeFileSync(target, 'not metro');
    symlinkSync(target, join(dir, 'connectors.json'));
    symlinkSync(join(root, 'missing.json'), join(dir, 'org-connector-sync.json'));
    mkdirSync(join(dir, 'connector-server-keys.json'));
    writeFileSync(join(dir, 'connector-migrations.json'), '{}');
    const warn = spyOn(log, 'warn');
    try {
      expect(removeConnectorLeftovers(dir)).toBe(1);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
    expect(lstatSync(join(dir, 'connectors.json')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dir, 'org-connector-sync.json')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dir, 'connector-server-keys.json')).isDirectory()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('not metro');
    expect(existsSync(join(dir, 'connector-migrations.json'))).toBe(false);
  });

  test('a missing folder is fine and logs no warning', () => {
    const warn = spyOn(log, 'warn');
    try {
      expect(removeConnectorLeftovers(join(root, 'absent'))).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('running it again removes nothing more', () => {
    for (const name of [...LEFTOVERS, ...KEPT]) writeFileSync(join(dir, name), '{}');
    expect(removeConnectorLeftovers(dir)).toBe(LEFTOVERS.length);
    const after = names();
    expect(removeConnectorLeftovers(dir)).toBe(0);
    expect(names()).toEqual(after);
  });
});
