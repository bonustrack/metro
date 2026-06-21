/**
 * Tests for the read-only monitor HTTP endpoints (auth + `/api/state`).
 * Shared subprocess harness lives in `monitor-helpers.ts`; `/api/tail` lives in
 * `monitor-tail.test.ts` and POST /api/call in `monitor-call.test.ts`.
 *
 * `recent_history` is now backed by the in-process bus ring buffer (events are
 * pushed in via the harness `/seed` endpoint), not a durable history.jsonl.
 */

import { describe, test } from 'bun:test';
import {
  TOKEN, expect, makeCtx, registerCleanup, startServer, freshStateDir, seedEvents, seedClaims, seedBotIds,
} from './monitor-helpers.ts';

const ctx = makeCtx();
registerCleanup(ctx);

describe('monitor auth', () => {
  test('401 when no Authorization header', async () => {
    const stateDir = freshStateDir(ctx);
    ctx.server = await startServer({ METRO_STATE_DIR: stateDir, METRO_MONITOR_TOKEN: TOKEN });
    const r = await fetch(`${ctx.server.url}/api/state`);
    expect(r.status).toBe(401);
    const j = await r.json() as { error: string };
    expect(j.error).toBe('unauthorized');
  });

  test('401 with wrong bearer token', async () => {
    const stateDir = freshStateDir(ctx);
    ctx.server = await startServer({ METRO_STATE_DIR: stateDir, METRO_MONITOR_TOKEN: TOKEN });
    const r = await fetch(`${ctx.server.url}/api/state`, {
      headers: { authorization: 'Bearer not-the-right-token' },
    });
    expect(r.status).toBe(401);
  });

  test('401 with malformed Authorization (no Bearer prefix)', async () => {
    const stateDir = freshStateDir(ctx);
    ctx.server = await startServer({ METRO_STATE_DIR: stateDir, METRO_MONITOR_TOKEN: TOKEN });
    const r = await fetch(`${ctx.server.url}/api/state`, {
      headers: { authorization: TOKEN },
    });
    expect(r.status).toBe(401);
  });

  test('503 when METRO_MONITOR_TOKEN is unset', async () => {
    const stateDir = freshStateDir(ctx);
    /** Explicitly clear the env var inside the child. */
    ctx.server = await startServer({ METRO_STATE_DIR: stateDir, METRO_MONITOR_TOKEN: '' });
    const r = await fetch(`${ctx.server.url}/api/state`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(503);
    const j = await r.json() as { error: string };
    expect(j.error).toContain('not configured');
  });
});

describe('GET /api/state', () => {
  test('200 with claims, lines, recent_history, bot_ids', async () => {
    const stateDir = freshStateDir(ctx);
    seedClaims(stateDir, { 'metro://discord/123': 'metro://claude/user/abc' });
    seedBotIds(stateDir, { discord: '999', telegram: '888' });

    ctx.server = await startServer({ METRO_STATE_DIR: stateDir, METRO_MONITOR_TOKEN: TOKEN });
    await seedEvents(ctx.server, [
      {
        id: 'msg_aaa', ts: '2026-05-17T00:00:00.000Z', station: 'discord',
        line: 'metro://discord/123', from: 'metro://discord/user/9', to: 'metro://discord/123', text: 'hi',
      },
      {
        id: 'msg_bbb', ts: '2026-05-17T00:00:01.000Z', station: 'telegram',
        line: 'metro://telegram/456', from: 'metro://telegram/user/2', to: 'metro://telegram/456', text: 'ho',
      },
    ]);

    const r = await fetch(`${ctx.server.url}/api/state`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    const body = await r.json() as {
      claims: Record<string, string>;
      lines: string[];
      recent_history: Array<{ id: string }>;
      bot_ids: Record<string, string>;
    };
    expect(body.claims).toEqual({ 'metro://discord/123': 'metro://claude/user/abc' });
    expect(body.lines).toContain('metro://discord/123');
    expect(body.lines).toContain('metro://telegram/456');
    expect(body.recent_history.length).toBe(2);
    /** Most-recent-first. */
    expect(body.recent_history[0].id).toBe('msg_bbb');
    expect(body.bot_ids).toEqual({ discord: '999', telegram: '888' });
  });

  test('empty state — 200 with empty maps', async () => {
    const stateDir = freshStateDir(ctx);
    ctx.server = await startServer({ METRO_STATE_DIR: stateDir, METRO_MONITOR_TOKEN: TOKEN });
    const r = await fetch(`${ctx.server.url}/api/state`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    const body = await r.json() as {
      claims: Record<string, string>;
      lines: string[];
      recent_history: unknown[];
      bot_ids: Record<string, string>;
    };
    expect(body.claims).toEqual({});
    expect(body.lines).toEqual([]);
    expect(body.recent_history).toEqual([]);
    expect(body.bot_ids).toEqual({});
  });
});
