import { describe, expect, test } from 'bun:test';
import { systemLabel, toMachine, uptimeLabel } from '../src/api/machine';

describe('what the page shows about a machine', () => {
  test('a daemon answer is read with safe defaults', () => {
    const machine = toMachine({ hostname: 'tony', platform: 'linux', arch: 'x64', port: 8420, publicUrl: 'https://metro-abc123.tail1234.ts.net', uptimeSeconds: 90_061, bun: '1.4.0', version: '0.1.0-beta.63', agentsDir: '/root/.metro/agents', claudeDir: '/root/.claude', runtimeStore: null, owner: null, startedAt: null });
    expect(systemLabel(machine)).toBe('Linux x64');
    expect(uptimeLabel(machine.uptimeSeconds)).toBe('1d 1h');
    expect(uptimeLabel(3_700)).toBe('1h 1m');
    expect(uptimeLabel(59)).toBe('0m');
    expect(machine.runtimeStore).toBeNull();
    expect(() => toMachine({ nope: 1 })).toThrow('unexpected');
  });
});
