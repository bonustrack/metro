/** Tests for the public /health page + the authed /api/accounts fan-out endpoint. */

import { describe, test } from 'bun:test';
import {
  TOKEN, expect, makeCtx, registerCleanup, startServer, freshStateDir, startMockIpc,
} from './monitor-helpers.ts';

const ctx = makeCtx();
registerCleanup(ctx);

/** Mock IPC that answers the per-station `accounts` action with public-only ids. */
function accountsIpc(stateDir: string) {
  return startMockIpc(stateDir, req => {
    if (req.action !== 'accounts') return { ok: true, response: { result: {} } };
    const byStation: Record<string, unknown[]> = {
      xmtp: [{ id: 'tony', address: '0xabc', inboxId: 'inbox1', env: 'production', owner: null, keySource: 'derive:0' }],
      discord: [{ id: 'd0', userId: '111', username: 'chen', owner: null, ready: true }],
      telegram: [{ id: 't0', owner: null, botId: 222, username: 'chen_bot' }],
    };
    return { ok: true, response: { result: { accounts: byStation[req.train ?? ''] ?? [] } } };
  });
}

describe('GET /health (public)', () => {
  test('200 — no auth required, exposes accounts but no secrets', async () => {
    const stateDir = freshStateDir(ctx);
    ctx.ipcServer = await accountsIpc(stateDir);
    ctx.server = await startServer({ METRO_STATE_DIR: stateDir, METRO_MONITOR_TOKEN: TOKEN });

    const r = await fetch(`${ctx.server.url}/health`);
    expect(r.status).toBe(200);
    const j = await r.json() as {
      ok: boolean; service: string; accounts: Record<string, Array<Record<string, unknown>>>;
    };
    expect(j.ok).toBe(true);
    expect(j.service).toBe('metro');
    expect(j.accounts.xmtp[0].address).toBe('0xabc');
    expect(j.accounts.discord[0].username).toBe('chen');
    expect(j.accounts.telegram[0].username).toBe('chen_bot');
    // No secret material anywhere in the public body.
    const blob = JSON.stringify(j).toLowerCase();
    expect(blob.includes('token')).toBe(false);
    expect(blob.includes('privatekey')).toBe(false);
    expect(blob.includes('mnemonic')).toBe(false);
  });

  test('200 — /health stays up even with no daemon IPC (accounts empty)', async () => {
    const stateDir = freshStateDir(ctx);
    /** No mock IPC: gatherAccounts swallows the failure, /health still 200s. */
    ctx.server = await startServer({ METRO_STATE_DIR: stateDir, METRO_MONITOR_TOKEN: TOKEN });
    const r = await fetch(`${ctx.server.url}/health`);
    expect(r.status).toBe(200);
    const j = await r.json() as { ok: boolean; accounts: Record<string, unknown[]> };
    expect(j.ok).toBe(true);
    expect(j.accounts.xmtp).toEqual([]);
  });
});

describe('GET /api/accounts (authed)', () => {
  test('401 — without bearer token', async () => {
    const stateDir = freshStateDir(ctx);
    ctx.server = await startServer({ METRO_STATE_DIR: stateDir, METRO_MONITOR_TOKEN: TOKEN });
    const r = await fetch(`${ctx.server.url}/api/accounts`);
    expect(r.status).toBe(401);
  });

  test('200 — fans out the accounts action across stations', async () => {
    const stateDir = freshStateDir(ctx);
    ctx.ipcServer = await accountsIpc(stateDir);
    ctx.server = await startServer({ METRO_STATE_DIR: stateDir, METRO_MONITOR_TOKEN: TOKEN });
    const r = await fetch(`${ctx.server.url}/api/accounts`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    const j = await r.json() as { accounts: Record<string, unknown[]> };
    expect(j.accounts.xmtp.length).toBe(1);
    expect(j.accounts.discord.length).toBe(1);
    expect(j.accounts.telegram.length).toBe(1);
  });
});
