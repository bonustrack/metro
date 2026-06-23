import { describe, expect, test } from 'bun:test';
import { Keepalive } from '../src/keepalive.ts';

const noop = (): void => undefined;

describe('MCP keepalive lifecycle', () => {
  test('start begins ticking on the interval', async () => {
    let pings = 0;
    const ka = new Keepalive({
      ping: async () => {
        pings += 1;
      },
      log: noop,
      intervalMs: 10,
    });
    expect(ka.running).toBe(false);
    ka.start();
    expect(ka.running).toBe(true);
    await new Promise((r) => setTimeout(r, 45));
    ka.stop();
    expect(pings).toBeGreaterThanOrEqual(2);
  });

  test('stop halts further ticks and is idempotent', async () => {
    let pings = 0;
    const ka = new Keepalive({
      ping: async () => {
        pings += 1;
      },
      log: noop,
      intervalMs: 10,
    });
    ka.start();
    await new Promise((r) => setTimeout(r, 25));
    ka.stop();
    expect(ka.running).toBe(false);
    const after = pings;
    ka.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(pings).toBe(after);
  });

  test('double start does not stack intervals', async () => {
    let pings = 0;
    const ka = new Keepalive({
      ping: async () => {
        pings += 1;
      },
      log: noop,
      intervalMs: 10,
    });
    ka.start();
    ka.start();
    ka.start();
    await new Promise((r) => setTimeout(r, 35));
    ka.stop();
    expect(pings).toBeLessThanOrEqual(4);
    expect(pings).toBeGreaterThanOrEqual(2);
  });

  test('a failing ping (write after close) is swallowed and does not stop the loop', async () => {
    let calls = 0;
    const logged: unknown[][] = [];
    const ka = new Keepalive({
      ping: async () => {
        calls += 1;
        throw new Error('stream closed');
      },
      log: (...a: unknown[]) => {
        logged.push(a);
      },
      intervalMs: 10,
    });
    ka.start();
    await new Promise((r) => setTimeout(r, 35));
    ka.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(logged.length).toBeGreaterThanOrEqual(2);
  });
});
