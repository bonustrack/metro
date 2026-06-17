/**
 * PR7 — webhook → session routing. The binding is fully ADDITIVE: an endpoint
 * with no `session` mints exactly today's event (parity), while a bound endpoint
 * attributes its event to `metro://session/<id>` so feed isolation routes it.
 *
 * Plus: GitHub events are authored by the synthetic `github` account and carry a
 * readable one-liner (see github-webhook.test.ts for the formatting matrix). The
 * webhook `line`/attribution rules below still hold for them.
 */

import { describe, expect, test } from 'bun:test';
import { webhookEntry } from '../src/dispatcher/server.ts';
import { passesMode } from '../src/broker/history-stream.ts';
import { sessionOwner } from '../src/sessions.ts';
import { Line, asLine } from '../src/lines.ts';
import { githubFrom } from '../src/github-webhook.ts';
import type { Endpoint } from '../src/tunnel.ts';

const ep = (over: Partial<Endpoint> = {}): Endpoint => ({
  id: 'abc123', label: 'gh', createdAt: '2026-06-10T00:00:00.000Z', ...over,
});
const headers = { 'x-github-event': 'push', 'x-github-delivery': 'd-1' };
const body = { repository: { full_name: 'bonustrack/metro' }, sender: { login: 'less' },
  ref: 'refs/heads/main', commits: [{ message: 'fix: thing' }], head_commit: { message: 'fix: thing' } };

describe('webhook → session routing (additive)', () => {
  test('NO binding ⇒ webhook line, authored by github account, readable text', () => {
    const e = webhookEntry(ep(), headers, body, 'POST', '/wh/abc123')!;
    const line = Line.webhook('abc123');
    expect(e.to).toBe(line);
    expect(e.from).toBe(githubFrom());
    expect(e.fromName).toBe('github');
    expect(e.line).toBe(line);
    expect(e.station).toBe('webhook');
    expect(e.lineName).toBe('gh');
    expect(e.messageId).toBe('d-1');
    expect(e.text).toBe('bonustrack/metro: less pushed 1 commit to main — fix: thing');
    expect(e.payload).toEqual({ headers, body });
  });

  test('non-GitHub webhook ⇒ legacy parity (raw text, from === line)', () => {
    const h = { 'x-intercom-topic': 'conversation.user.created', 'x-request-id': 'r-1' };
    const e = webhookEntry(ep(), h, {}, 'POST', '/wh/abc123')!;
    expect(e.from).toBe(Line.webhook('abc123'));
    expect(e.fromName).toBeUndefined();
    expect(e.text).toBe('conversation.user.created POST /wh/abc123');
  });

  test('skipped GitHub event (ping) ⇒ null (dropped, no channel noise)', () => {
    const e = webhookEntry(ep(), { 'x-github-event': 'ping', 'x-github-delivery': 'p-1' }, {}, 'POST', '/wh/abc123');
    expect(e).toBeNull();
  });

  test('NO binding ⇒ excluded from a personal feed (unchanged isolation)', () => {
    const e = webhookEntry(ep(), headers, body, 'POST', '/wh/abc123')!;
    const self = asLine('metro://session/me');
    // mine-only must NOT surface an unbound webhook to a session owner
    expect(passesMode(e, 'mine-only', self, {})).toBe(false);
  });

  test('bound endpoint ⇒ to = session owner, surfaces in that session feed', () => {
    const e = webhookEntry(ep({ session: 'me' }), headers, body, 'POST', '/wh/abc123')!;
    const owner = sessionOwner('me');
    expect(e.to).toBe(owner);
    // line stays the webhook line — only attribution (`to`) changes; from = github author
    expect(e.line).toBe(Line.webhook('abc123'));
    expect(e.from).toBe(githubFrom());
    // now it routes to that owner's personal feed (to === self wins in passesMode)
    expect(passesMode(e, 'mine-only', owner, {})).toBe(true);
    // and stays OUT of a different session's feed
    expect(passesMode(e, 'mine-only', sessionOwner('other'), {})).toBe(false);
  });
});
