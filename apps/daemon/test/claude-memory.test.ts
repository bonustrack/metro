import { describe, expect, test } from 'bun:test';
import { ensureServiceOomPolicy, inSessionScope, sessionMemoryLimit, type ScopeHost } from '../src/claude/memory.ts';

const GIB = 1024 ** 3;
const box = (over: Partial<ScopeHost> = {}): ScopeHost => ({ platform: 'linux', uid: 0, systemd: true, total: 8 * GIB, ...over });

describe('the Claude session gets its own memory limit', () => {
  test('80% of the box, always leaving 1.5 GiB for Metro, never under 1 GiB', () => {
    expect(sessionMemoryLimit(8 * GIB) / GIB).toBeCloseTo(6.4, 1);
    expect(sessionMemoryLimit(4 * GIB) / GIB).toBeCloseTo(2.5, 1);
    expect(sessionMemoryLimit(2 * GIB)).toBe(GIB);
    expect(sessionMemoryLimit(64 * GIB) / GIB).toBeCloseTo(51.2, 1);
  });

  test('tmux starts in a systemd scope of its own that keeps running when one process is killed', () => {
    const [file, args] = inSessionScope(['setpriv', ['--reuid=1001', 'tmux', 'new-session']], box(), 42);
    expect(file).toBe('systemd-run');
    expect(args).toContain('--scope');
    expect(args).toContain('--unit=metro-claude-42');
    expect(args).toContain(`MemoryMax=${String(sessionMemoryLimit(8 * GIB))}`);
    expect(args).toContain('OOMPolicy=continue');
    expect(args.slice(args.indexOf('--') + 1)).toEqual(['setpriv', '--reuid=1001', 'tmux', 'new-session']);
  });

  test('left alone off Linux, without root or without systemd', () => {
    const command: [string, string[]] = ['tmux', ['new-session']];
    for (const over of [{ platform: 'darwin' }, { uid: 501 }, { systemd: false }])
      expect(inSessionScope(command, box(over))).toEqual(command);
  });

  test('the service policy is only touched on a box running metro under systemd as root', () => {
    expect(ensureServiceOomPolicy(box({ platform: 'darwin' }), { INVOCATION_ID: 'x' })).toBe('skipped');
    expect(ensureServiceOomPolicy(box(), {})).toBe('skipped');
  });
});
