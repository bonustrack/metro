import { beforeEach, describe, expect, test } from 'bun:test';
import type { Connection } from '@metro-labs/inference/model-config';
import { forgetUsage, usageOf } from '@metro-labs/inference/usage';
import { UsageProbes } from '../src/usage-probes.ts';

const OWNER = 'org_01TESTOWNER00000';

const connection = (id: string, fields: Partial<Connection> = {}): Connection => ({
  id,
  provider: 'openrouter',
  label: 'OpenRouter',
  model: 'x/y',
  apiKey: 'sk-or',
  region: '',
  zdr: false,
  revision: 1,
  codex: null,
  claudeToken: '',
  account: { email: null, plan: null, method: null },
  signedOut: false,
  ...fields,
});

let now = 0;
let asked = 0;
let refuse = false;
const seen: [string, string][] = [];

const fetchImpl = (async () => {
  asked += 1;
  return refuse ? new Response('no', { status: 401 }) : new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 5, usage: 5 } }));
}) as unknown as typeof fetch;

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  forgetUsage();
  now = 1_793_000_000_000;
  asked = 0;
  refuse = false;
  seen.length = 0;
});

describe('the gateway asks the accounts of the setups it loads for their usage', () => {
  test('a loaded account is asked at once, then at most every 5 minutes, and handed to the window saver', async () => {
    const probes = new UsageProbes({ seen: (owner, id) => seen.push([owner, id]) }, { fetchImpl, openrouterBase: 'https://or.test/api' }, () => now);
    probes.track(OWNER, [connection('or000000001'), connection('ant00000001', { provider: 'anthropic', apiKey: 'sk-ant' })]);
    await settled();
    expect(seen).toEqual([[OWNER, 'or000000001']]);
    expect(asked).toBe(1);
    expect(usageOf('or000000001')?.windows[0]).toMatchObject({ label: 'Credits', used: 0.5 });
    probes.track(OWNER, [connection('or000000001')]);
    now += 60_000;
    probes.tick();
    await settled();
    expect(asked).toBe(1);
    now += 5 * 60_000;
    probes.tick();
    await settled();
    expect(asked).toBe(2);
  });

  test('an account no setup named for an hour is no longer asked, and a refusal leaves no window', async () => {
    refuse = true;
    const probes = new UsageProbes({ seen: () => undefined }, { fetchImpl, openrouterBase: 'https://or.test/api' }, () => now);
    probes.track(OWNER, [connection('or000000002')]);
    await settled();
    expect(usageOf('or000000002')).toBeUndefined();
    now += 61 * 60_000;
    probes.tick();
    await settled();
    expect(asked).toBe(1);
  });
});
