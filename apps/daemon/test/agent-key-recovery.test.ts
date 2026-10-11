import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearPendingAgentKey, newAgentKey, readPendingAgentKey, saveAgentKey, savePendingAgentKey } from '../src/connectors/agent-key.ts';

const OWNER = 'org_01AGENTOWNER00000';
const HASH = 'T'.repeat(43);
let dir = '';

beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'metro-key-recovery-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('pending and active keys flush their files and directory before cleanup', () => {
  const key = newAgentKey();
  const flushes = spyOn(fs, 'fsyncSync');
  try {
    savePendingAgentKey(key, OWNER, HASH, dir);
    expect(flushes).toHaveBeenCalledTimes(2);
    saveAgentKey(key, { server: 'agent000001', organization: OWNER, at: new Date().toISOString() }, dir);
    expect(flushes).toHaveBeenCalledTimes(4);
    clearPendingAgentKey(dir);
    expect(flushes).toHaveBeenCalledTimes(5);
  } finally {
    flushes.mockRestore();
  }
});

test('a flush failure is surfaced with the candidate retained for recovery', () => {
  const key = newAgentKey();
  savePendingAgentKey(key, OWNER, HASH, dir);
  const flushes = spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('flush failed'); });
  try {
    expect(() => savePendingAgentKey(newAgentKey(), OWNER, HASH, dir)).toThrow('flush failed');
    expect(readPendingAgentKey(OWNER, dir)?.keyId).toBe(key.keyId);
    expect(fs.readdirSync(dir)).toEqual(['agent-key.pending.json']);
  } finally {
    flushes.mockRestore();
  }
});

test('a pending key that cannot be read is not treated as an empty slot', () => {
  savePendingAgentKey(newAgentKey(), OWNER, HASH, dir);
  const path = join(dir, 'agent-key.pending.json');
  const read = spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('temporarily unreadable'); });
  try {
    expect(() => readPendingAgentKey(OWNER, dir)).toThrow('Restore its file or permissions');
    expect(fs.existsSync(path)).toBe(true);
  } finally {
    read.mockRestore();
  }
  expect(readPendingAgentKey(OWNER, dir)).not.toBeNull();
});
