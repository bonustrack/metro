import { afterEach, describe, expect, test } from 'bun:test';
import {
  RuntimeRevoked,
  runtimeConfigFromEnv,
  startRuntimePoller,
} from '../src/daemon/runtime-source.ts';

const KEEP = {
  token: process.env.METRO_RUN_TOKEN,
  url: process.env.METRO_URL,
};

afterEach(() => {
  for (const [k, v] of Object.entries({
    METRO_RUN_TOKEN: KEEP.token,
    METRO_URL: KEEP.url,
  }))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

describe('local mode is opt-in, and never inferred', () => {
  test('with no run token there is no local config at all', () => {
    delete process.env.METRO_RUN_TOKEN;
    expect(runtimeConfigFromEnv()).toBeNull();
  });

  test('a run token selects local mode and defaults to production metro', () => {
    process.env.METRO_RUN_TOKEN = 'run-token';
    delete process.env.METRO_URL;
    expect(runtimeConfigFromEnv()).toEqual({
      url: 'https://mcp.metro.box',
      token: 'run-token',
    });
  });

  test('station credentials are never fetched over plaintext http', () => {
    process.env.METRO_RUN_TOKEN = 'run-token';
    for (const bad of [
      'http://metro.example.com',
      'http://10.0.0.5:8420',
      'http://evil.test',
      'not-a-url',
    ]) {
      process.env.METRO_URL = bad;
      expect(() => runtimeConfigFromEnv()).toThrow(/in the clear|https/);
    }
  });

  test('loopback http is allowed, because it never leaves the machine', () => {
    process.env.METRO_RUN_TOKEN = 'run-token';
    for (const ok of ['http://127.0.0.1:8420', 'http://localhost:8420']) {
      process.env.METRO_URL = ok;
      expect(runtimeConfigFromEnv()?.url).toBe(ok);
    }
  });

  test('a trailing slash on METRO_URL does not become a double slash', () => {
    process.env.METRO_RUN_TOKEN = 'run-token';
    process.env.METRO_URL = 'http://127.0.0.1:8420/';
    expect(runtimeConfigFromEnv()?.url).toBe('http://127.0.0.1:8420');
  });
});

describe('the poller distinguishes revoked from unreachable', () => {
  test('being revoked stops the stations and never retries', async () => {
    let stopped = 0;
    let syncs = 0;
    const stop = startRuntimePoller({
      everyMs: 1,
      sync: () => {
        syncs += 1;
        return Promise.reject(new RuntimeRevoked('gone'));
      },
      stopAll: () => {
        stopped += 1;
        return Promise.resolve();
      },
    });
    await Bun.sleep(40);
    stop();
    expect(stopped).toBe(1);
    expect(syncs).toBe(1);
  });

  test('an unreachable metro does NOT stop the stations', async () => {
    let stopped = 0;
    let syncs = 0;
    const stop = startRuntimePoller({
      everyMs: 1,
      backoffMs: 1,
      sync: () => {
        syncs += 1;
        return Promise.reject(new Error('network down'));
      },
      stopAll: () => {
        stopped += 1;
        return Promise.resolve();
      },
    });
    await Bun.sleep(40);
    stop();
    expect(stopped).toBe(0);
    expect(syncs).toBeGreaterThan(1);
  });

  test('stopping the poller is idempotent and leaves no timer behind', () => {
    const stop = startRuntimePoller({
      sync: () => Promise.resolve(),
      stopAll: () => Promise.resolve(),
    });
    expect(() => {
      stop();
      stop();
    }).not.toThrow();
  });
});
