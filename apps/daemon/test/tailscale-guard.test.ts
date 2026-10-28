import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hardenTailscale, withoutForwarding } from '../src/metro-user/tailscale-guard.ts';

let dir = '';
let defaults = '';
let calls: string[] = [];

const runner = (fails: string[] = []) => (file: string, args: string[]): boolean => {
  const call = [file, ...args].join(' ');
  calls.push(call);
  return !fails.includes(call);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-tailscale-'));
  defaults = join(dir, 'tailscaled');
  calls = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the root side switches off Tailscale SSH forwarding and turns on auto-update', () => {
  test('the forwarding line is added once, after what the file already holds', () => {
    expect(withoutForwarding('PORT="41641"\nFLAGS=""\n')).toBe('PORT="41641"\nFLAGS=""\nTS_SSH_DISABLE_FORWARDING=1\n');
    expect(withoutForwarding('FLAGS=""')).toBe('FLAGS=""\nTS_SSH_DISABLE_FORWARDING=1\n');
    expect(withoutForwarding('')).toBe('TS_SSH_DISABLE_FORWARDING=1\n');
    expect(withoutForwarding('FLAGS=""\nTS_SSH_DISABLE_FORWARDING=1\n')).toBeNull();
  });

  test('the first run writes the line, restarts tailscaled and turns on auto-update; the next run restarts nothing', () => {
    writeFileSync(defaults, 'PORT="41641"\nFLAGS=""\n');
    expect(hardenTailscale(runner(), defaults)).toEqual(['Tailscale SSH forwarding is off']);
    expect(readFileSync(defaults, 'utf8')).toContain('TS_SSH_DISABLE_FORWARDING=1');
    expect(calls).toEqual(['tailscale version', 'systemctl restart tailscaled', 'tailscale set --auto-update']);
    calls = [];
    expect(hardenTailscale(runner(), defaults)).toEqual([]);
    expect(calls).toEqual(['tailscale version', 'tailscale set --auto-update']);
  });

  test('a box without Tailscale is left alone, and a failing step only leaves a note', () => {
    expect(hardenTailscale(runner(['tailscale version']), defaults)).toEqual(['tailscale is not installed here, nothing to harden']);
    expect(calls).toEqual(['tailscale version']);
    expect(hardenTailscale(runner(['systemctl restart tailscaled', 'tailscale set --auto-update']), defaults)).toEqual([
      'wrote TS_SSH_DISABLE_FORWARDING=1, but tailscaled did not restart; it applies at its next start',
      'tailscale set --auto-update failed; update Tailscale by hand',
    ]);
  });
});
