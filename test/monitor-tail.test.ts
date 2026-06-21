/**
 * Tests for the monitor's `GET /api/tail` SSE stream + misc `/api/*` paths.
 * Companion to monitor.test.ts (auth + /api/state); shared harness in monitor-helpers.ts.
 *
 * The tail now subscribes to the in-process bus. `?since=0` replays the bounded
 * ring backlog then streams live; default (`since=tail`) streams live-only.
 * Events are injected via the harness `/seed` endpoint.
 */

import { describe, test } from 'bun:test';
import {
  TOKEN, expect, makeCtx, registerCleanup, startServer, freshStateDir, seedEvents,
} from './monitor-helpers.ts';

const ctx = makeCtx();
registerCleanup(ctx);

describe('GET /api/tail (SSE)', () => {
  test('replays ring backlog with ?since=0', async () => {
    const stateDir = freshStateDir(ctx);
    ctx.server = await startServer({ METRO_STATE_DIR: stateDir, METRO_MONITOR_TOKEN: TOKEN });
    await seedEvents(ctx.server, [
      {
        id: 'msg_111', ts: '2026-05-17T00:00:00.000Z', station: 'discord',
        line: 'metro://discord/1', from: 'metro://discord/user/x', to: 'metro://discord/1', text: 'first',
      },
    ]);

    const ctrl = new AbortController();
    const r = await fetch(`${ctx.server.url}/api/tail?since=0`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: ctrl.signal,
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');

    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 3_000;
    while (!buf.includes('msg_111') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    ctrl.abort();
    expect(buf).toContain('event: history');
    expect(buf).toContain('msg_111');
    expect(buf).toContain('"text":"first"');
  });

  test('400 on non-numeric ?since (mirrors CLI --since validation, not silent EOF)', async () => {
    const stateDir = freshStateDir(ctx);
    ctx.server = await startServer({ METRO_STATE_DIR: stateDir, METRO_MONITOR_TOKEN: TOKEN });
    const r = await fetch(`${ctx.server.url}/api/tail?since=abc`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(400);
    const j = await r.json() as { error: string };
    expect(j.error).toContain('byte offset');
  });

  test('400 on negative ?since', async () => {
    const stateDir = freshStateDir(ctx);
    ctx.server = await startServer({ METRO_STATE_DIR: stateDir, METRO_MONITOR_TOKEN: TOKEN });
    const r = await fetch(`${ctx.server.url}/api/tail?since=-5`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(400);
  });

  test('live events arrive on a default (live-only) tail; backlog NOT replayed', async () => {
    const stateDir = freshStateDir(ctx);
    ctx.server = await startServer({ METRO_STATE_DIR: stateDir, METRO_MONITOR_TOKEN: TOKEN });
    /** This pre-connect event must NOT be replayed on a default tail. */
    await seedEvents(ctx.server, [
      {
        id: 'msg_old', ts: '2026-05-17T00:00:00.000Z', station: 'discord',
        line: 'metro://discord/1', from: 'metro://discord/user/x', to: 'metro://discord/1', text: 'pre',
      },
    ]);

    const ctrl = new AbortController();
    /** Default since=tail — live-only; backlog NOT replayed. */
    const r = await fetch(`${ctx.server.url}/api/tail`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: ctrl.signal,
    });
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    const dec = new TextDecoder();

    /** Give the handler a moment to subscribe, then publish a fresh event. */
    await new Promise(res => setTimeout(res, 200));
    await seedEvents(ctx.server, [
      {
        id: 'msg_new', ts: '2026-05-17T00:01:00.000Z', station: 'discord',
        line: 'metro://discord/1', from: 'metro://discord/user/x', to: 'metro://discord/1', text: 'live',
      },
    ]);

    let buf = '';
    const deadline = Date.now() + 5_000;
    while (!buf.includes('msg_new') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    ctrl.abort();
    expect(buf).toContain('msg_new');
    expect(buf).toContain('"text":"live"');
    expect(buf).not.toContain('msg_old');
  });
});

describe('GET /api/* misc', () => {
  test('unknown /api/* path → 404', async () => {
    const stateDir = freshStateDir(ctx);
    ctx.server = await startServer({ METRO_STATE_DIR: stateDir, METRO_MONITOR_TOKEN: TOKEN });
    const r = await fetch(`${ctx.server.url}/api/nope`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(404);
  });

  test('POST /api/state → 405 (read-only)', async () => {
    const stateDir = freshStateDir(ctx);
    ctx.server = await startServer({ METRO_STATE_DIR: stateDir, METRO_MONITOR_TOKEN: TOKEN });
    const r = await fetch(`${ctx.server.url}/api/state`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(405);
  });
});
