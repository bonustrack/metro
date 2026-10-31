import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liftSessionSoftLimits } from '../src/metro-user/session-scopes.ts';

let slice = '';
let calls: string[] = [];

const runner = (fails: string[] = []) => (file: string, args: string[]): boolean => {
  const call = [file, ...args].join(' ');
  calls.push(call);
  return !fails.includes(call);
};

const scope = (name: string, high: string | null): void => {
  mkdirSync(join(slice, name), { recursive: true });
  if (high !== null) writeFileSync(join(slice, name, 'memory.high'), `${high}\n`);
};

beforeEach(() => {
  slice = mkdtempSync(join(tmpdir(), 'metro-slice-'));
  calls = [];
});

afterEach(() => {
  rmSync(slice, { recursive: true, force: true });
});

describe('the root side lifts the soft memory limit of sessions started before beta.328', () => {
  test('only a running session scope that still has a soft limit is changed, through systemd', () => {
    scope('metro-claude-1793188671597066068.scope', '2159226880');
    scope('metro-claude-1793188671597066069.scope', 'max');
    scope('metro.service', '2159226880');
    scope('metro-claude-x.scope', '1');
    expect(liftSessionSoftLimits(runner(), slice)).toEqual(['metro-claude-1793188671597066068.scope: its soft memory limit is lifted, so only the hard limit applies']);
    expect(calls).toEqual(['systemctl set-property --runtime metro-claude-1793188671597066068.scope MemoryHigh=infinity']);
  });

  test('a refusal is only a note, and a machine without the slice changes nothing', () => {
    scope('metro-claude-1.scope', '100');
    expect(liftSessionSoftLimits(runner(['systemctl set-property --runtime metro-claude-1.scope MemoryHigh=infinity']), slice)).toEqual([
      'metro-claude-1.scope: its soft memory limit could not be lifted; it goes when the session starts again',
    ]);
    expect(liftSessionSoftLimits(runner(), join(slice, 'missing'))).toEqual([]);
  });
});
