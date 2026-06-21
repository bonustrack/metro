/**
 * In-process tests for the broker predicate `passesMode`
 * (webhook gating, per-CLI feed isolation).
 */

import { describe, expect, test } from 'bun:test';
import { passesMode } from '../src/event-bus.ts';
import { asLine } from '../src/lines.ts';
import type { MetroEvent } from '../src/events.ts';
import { WORKER_A, CHAT_LINE, WEBHOOK_LINE } from './broker-helpers.ts';

describe('passesMode webhook gating', () => {
  const webhookEvent: MetroEvent = {
    id: 'msg_w1', ts: '2026-05-16T00:00:00Z', kind: 'inbound', station: 'webhook',
    line: asLine(WEBHOOK_LINE), from: asLine('metro://webhook/gh-main'), to: asLine(WEBHOOK_LINE),
    text: 'push to main',
  };
  const chatEvent: MetroEvent = {
    id: 'msg_c1', ts: '2026-05-16T00:00:01Z', kind: 'inbound', station: 'discord',
    line: asLine(CHAT_LINE), from: asLine('metro://discord/u/alice'), to: asLine(CHAT_LINE),
    text: 'hi',
  };
  const claims = {};

  test('mine-or-unclaimed: chat passes, webhook does NOT (default)', () => {
    expect(passesMode(chatEvent, 'mine-or-unclaimed', asLine(WORKER_A), claims)).toBe(true);
    expect(passesMode(webhookEvent, 'mine-or-unclaimed', asLine(WORKER_A), claims)).toBe(false);
  });

  test('mine-only: webhook still excluded by default', () => {
    expect(passesMode(webhookEvent, 'mine-only', asLine(WORKER_A), { [WEBHOOK_LINE]: WORKER_A })).toBe(false);
  });

  test('mine-or-unclaimed + includeWebhooks: webhook passes', () => {
    expect(passesMode(webhookEvent, 'mine-or-unclaimed', asLine(WORKER_A), claims, { includeWebhooks: true })).toBe(true);
  });

  test('mine-only + includeWebhooks + claim match: webhook passes', () => {
    expect(passesMode(
      webhookEvent, 'mine-only', asLine(WORKER_A), { [WEBHOOK_LINE]: WORKER_A }, { includeWebhooks: true },
    )).toBe(true);
  });

  test('unclaimed: webhook passes (router sees ownerless events)', () => {
    expect(passesMode(webhookEvent, 'unclaimed', asLine(WORKER_A), claims)).toBe(true);
  });

  test('all: webhook passes (operator sees everything)', () => {
    expect(passesMode(webhookEvent, 'all', null, claims)).toBe(true);
  });
});

/** Per-self feed isolation contract that `metro tail --as=<self> --strict` relies */
/** on: the xmtp train owner-routes inbound by stamping `to = <owner>`, so a */
/** `mine-only` predicate keyed on a given self accepts ONLY that self's feed. */
describe('per-self feed isolation (mine-only / --as)', () => {
  const BEN_SELF = asLine('metro://xmtp/ben/user/ben-acct');
  const CLAUDE_SELF = asLine('metro://claude/user/claude-org');
  /** tony account → routed to the Claude owner */
  const tonyEvent: MetroEvent = {
    id: 'msg_t1', ts: '2026-05-29T00:00:00Z', kind: 'inbound', station: 'xmtp',
    line: asLine('metro://xmtp/tony/conv1'), from: asLine('metro://xmtp/tony/user/alice'),
    to: CLAUDE_SELF, text: 'for claude',
  };
  /** ben account → routed to the ben owner */
  const benEvent: MetroEvent = {
    id: 'msg_x1', ts: '2026-05-29T00:00:01Z', kind: 'inbound', station: 'xmtp',
    line: asLine('metro://xmtp/ben/conv2'), from: asLine('metro://xmtp/ben/user/bob'),
    to: BEN_SELF, text: 'for ben',
  };

  test('mine-only (self=ben) gets ONLY the ben feed', () => {
    expect(passesMode(benEvent, 'mine-only', BEN_SELF, {})).toBe(true);
    expect(passesMode(tonyEvent, 'mine-only', BEN_SELF, {})).toBe(false);
  });

  test('mine-only (self=claude) gets ONLY the tony feed', () => {
    expect(passesMode(tonyEvent, 'mine-only', CLAUDE_SELF, {})).toBe(true);
    expect(passesMode(benEvent, 'mine-only', CLAUDE_SELF, {})).toBe(false);
  });
});
