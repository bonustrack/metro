import { describe, expect, test } from 'bun:test';
import { untilState, type DaemonState } from '../src/api/control';

function script(states: DaemonState[]): () => Promise<DaemonState> {
  let i = 0;
  return () => {
    const state = states[Math.min(i, states.length - 1)] ?? 'offline';
    i += 1;
    return Promise.resolve(state);
  };
}

describe('waiting for the daemon to change state', () => {
  test('resolves true as soon as the wanted state shows, without waiting out the clock', async () => {
    const started = Date.now();
    expect(await untilState((s) => s === 'live', script(['offline', 'offline', 'live']), { everyMs: 1, maxMs: 5_000 })).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('resolves false once the clock runs out on a state that never comes', async () => {
    expect(await untilState((s) => s === 'stopped', script(['live']), { everyMs: 1, maxMs: 20 })).toBe(false);
  });

  test('a restart is seen as leaving live and coming back', async () => {
    const probe = script(['live', 'offline', 'offline', 'live']);
    expect(await untilState((s) => s !== 'live', probe, { everyMs: 1, maxMs: 1_000 })).toBe(true);
    expect(await untilState((s) => s === 'live', probe, { everyMs: 1, maxMs: 1_000 })).toBe(true);
  });
});
