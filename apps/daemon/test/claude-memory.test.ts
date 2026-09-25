import { describe, expect, test } from 'bun:test';
import { inSessionScope, sessionMemoryLimit, type ScopeHost } from '../src/claude/memory.ts';

const GIB = 1024 ** 3;
const box = (over: Partial<ScopeHost> = {}): ScopeHost => ({ metro: true, systemd: true, total: 8 * GIB, ...over });
const AS_AGENT: [string, string[]] = ['sudo', ['-n', '-u', 'agent', '--', 'env', '-i', 'HOME=/home/agent', 'tmux', 'new-session']];

describe('the Claude session gets its own memory limit', () => {
  test('80% of the box, always leaving 1.5 GiB for Metro, never under 1 GiB', () => {
    expect(sessionMemoryLimit(8 * GIB) / GIB).toBeCloseTo(6.4, 1);
    expect(sessionMemoryLimit(4 * GIB) / GIB).toBeCloseTo(2.5, 1);
    expect(sessionMemoryLimit(2 * GIB)).toBe(GIB);
    expect(sessionMemoryLimit(64 * GIB) / GIB).toBeCloseTo(51.2, 1);
  });

  test("the agent's tmux starts in a scope of its own, through the root helper", () => {
    const limit = sessionMemoryLimit(8 * GIB);
    expect(inSessionScope(AS_AGENT, box())).toEqual([
      'sudo',
      ['-n', '/usr/local/lib/metro/root-helper', 'as-agent-scope', String(limit), String(Math.floor(limit * 0.9)), 'env', '-i', 'HOME=/home/agent', 'tmux', 'new-session'],
    ]);
  });

  test('left alone off the metro user, without systemd, or for a command that is not the agent', () => {
    const plain: [string, string[]] = ['tmux', ['new-session']];
    expect(inSessionScope(plain, box())).toEqual(plain);
    for (const over of [{ metro: false }, { systemd: false }]) expect(inSessionScope(AS_AGENT, box(over))).toEqual(AS_AGENT);
  });
});
