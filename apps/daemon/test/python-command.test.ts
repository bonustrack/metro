import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PYTHON_PRESENT, placePythonCommand, pythonShim } from '../src/agent-user/python-command.ts';

let dir = '';
let bin = '';
let target = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-python-command-'));
  bin = join(dir, 'bin');
  mkdirSync(bin);
  target = join(dir, 'home', '.local', 'bin', 'python');
  mkdirSync(join(dir, 'home', '.local', 'bin'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const present = (): number | null => spawnSync('/bin/sh', ['-c', PYTHON_PRESENT, 'metro', target], { env: { PATH: bin } }).status;

describe('a python command for the agent', () => {
  test('is wanted only when no python answers on the agent path and nothing sits at its place', () => {
    expect(present()).toBe(1);
    writeFileSync(join(bin, 'python'), '#!/bin/sh\n', { mode: 0o755 });
    expect(present()).toBe(0);
    rmSync(join(bin, 'python'));
    writeFileSync(target, 'mine\n');
    expect(present()).toBe(0);
    rmSync(target);
    symlinkSync(join(dir, 'nowhere'), target);
    expect(present()).toBe(0);
  });

  test('runs python3 with every argument as given', () => {
    const shim = join(dir, 'shim');
    writeFileSync(shim, pythonShim('/bin/echo'), { mode: 0o755 });
    expect(spawnSync(shim, ['-c', 'two words'], { encoding: 'utf8' }).stdout).toBe('-c two words\n');
  });

  test('does nothing on a machine with no agent user or no python3', () => {
    expect(placePythonCommand(null)).toBe('skipped');
    expect(placePythonCommand({ name: 'agent', uid: 1001, gid: 1001, home: dir }, join(dir, 'no-python3'))).toBe('skipped');
  });
});
