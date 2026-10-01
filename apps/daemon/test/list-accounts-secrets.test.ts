import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { gatherAccounts, gatherAccountsForAgents } from '../src/mcp/accounts.ts';
import { setAgentMap } from '../src/agents/map.ts';

const AGENT = 'agent000001';
const HOOK_SECRET = 'Zx-Egym_QEc7slzQR37KDtVFZ1wrZaZb1NcXFED2uNI';
const CALLBACK_TOKEN = 'c'.repeat(64);

let dir: string;
let priorFile: string | undefined;
let priorPublic: string | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-list-accounts-'));
  const accountsFile = join(dir, 'webhook-accounts.json');
  writeFileSync(accountsFile, JSON.stringify([{ id: 'w1', webhookId: '1493556940637339623', label: 'github', secret: HOOK_SECRET }]));
  priorFile = process.env.WEBHOOK_ACCOUNTS_FILE;
  priorPublic = process.env.METRO_PUBLIC_URL;
  process.env.WEBHOOK_ACCOUNTS_FILE = accountsFile;
  process.env.METRO_PUBLIC_URL = 'https://box.metro.test/';
});

afterAll(() => {
  if (priorFile === undefined) delete process.env.WEBHOOK_ACCOUNTS_FILE;
  else process.env.WEBHOOK_ACCOUNTS_FILE = priorFile;
  if (priorPublic === undefined) delete process.env.METRO_PUBLIC_URL;
  else process.env.METRO_PUBLIC_URL = priorPublic;
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  setAgentMap({}, {});
});

describe('list_accounts never hands the agent a url that carries a secret', () => {
  test('the webhook token and the Threema callback token reach the page but not the agent', async () => {
    setAgentMap({ 'webhook/w1': AGENT, 'threema/t0': AGENT }, { [AGENT]: 'Emma' });
    setTrainCallBackend((train) =>
      Promise.resolve({
        result: {
          accounts: train === 'threema' ? [{ id: 't0', gatewayId: '*METRO01', callbackId: '1234567890123456789', callbackToken: CALLBACK_TOKEN }] : [],
        },
      }),
    );
    const page = (await gatherAccountsForAgents(new Set([AGENT]))).accounts;
    expect(JSON.stringify(page)).toContain(HOOK_SECRET);
    expect(JSON.stringify(page)).toContain(CALLBACK_TOKEN);

    const agent = await gatherAccounts(new Set([AGENT]));
    const text = JSON.stringify(agent);
    expect(text).not.toContain(HOOK_SECRET);
    expect(text).not.toContain(CALLBACK_TOKEN);
    expect(agent.webhook).toEqual([{ id: 'w1', handle: '/api/webhooks/1493556940637339623' }]);
    expect(agent.threema).toEqual([{ id: 't0', gatewayId: '*METRO01' }]);
  });
});
