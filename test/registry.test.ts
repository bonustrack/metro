/**
 * Tests for the per-station mutate registry (src/registry.ts).
 *
 *   - mutate sets: each station's MUTATE verbs are reported, and known READ
 *     verbs are excluded (the outbox only durably journals MUTATE sends).
 *   - core: the core MUTATE verbs (claim/release/webhook/tunnel) are reported.
 *   - send-guard parity: the historical hand-maintained guard set is a strict
 *     subset of the xmtp mutate set (the outbox must never under-cover a guarded
 *     send-bearing verb).
 *   - unknown owner: an owner with no station yields an empty set.
 */

import { describe, expect, test } from 'bun:test';
import { mutateVerbs } from '../src/registry.ts';

describe('mutateVerbs — station mutate sets', () => {
  test('xmtp reports its mutate verbs and excludes reads', () => {
    const m = mutateVerbs('xmtp');
    for (const a of ['send', 'reply', 'react', 'sendAttachment', 'newDm', 'newGroup', 'closeGroup', 'register-push'])
      expect(m.has(a), `xmtp missing mutate: ${a}`).toBe(true);
    for (const r of ['accounts', 'query', 'groupInfo', 'listConvs', 'list-push'])
      expect(m.has(r), `xmtp should not mutate read verb: ${r}`).toBe(false);
  });

  test('telegram reports its mutate verbs and excludes reads', () => {
    const m = mutateVerbs('telegram');
    for (const a of ['send', 'react', 'edit', 'delete', 'send_photo', 'send_location'])
      expect(m.has(a), `telegram missing mutate: ${a}`).toBe(true);
    for (const r of ['accounts', 'read', 'download'])
      expect(m.has(r), `telegram should not mutate read verb: ${r}`).toBe(false);
  });

  test('discord reports its mutate verbs and excludes reads', () => {
    const m = mutateVerbs('discord');
    for (const a of ['send', 'reply', 'react', 'edit', 'delete', 'thread_create', 'pin', 'voiceTranscribe'])
      expect(m.has(a), `discord missing mutate: ${a}`).toBe(true);
    for (const r of ['accounts', 'fetch', 'download', 'channel', 'voiceDebug'])
      expect(m.has(r), `discord should not mutate read verb: ${r}`).toBe(false);
  });

  test('core mutate verbs are claim/release/webhook/tunnel', () => {
    const m = mutateVerbs('core');
    expect([...m].sort()).toEqual(['claim', 'release', 'tunnel', 'webhook']);
  });

  test('an unknown owner yields an empty mutate set', () => {
    expect(mutateVerbs('nope').size).toBe(0);
  });
});

describe('mutateVerbs — send-guard parity', () => {
  const HISTORICAL_GUARDED = ['send', 'reply', 'react', 'sendAttachment', 'newDm', 'newGroup'];

  test('every historically-guarded xmtp action is an xmtp mutate', () => {
    const m = mutateVerbs('xmtp');
    for (const a of HISTORICAL_GUARDED)
      expect(m.has(a), `guarded action not registry-mutate: ${a}`).toBe(true);
  });

  test('the guard set is a strict subset of xmtp mutates', () => {
    const m = mutateVerbs('xmtp');
    expect(HISTORICAL_GUARDED.every(a => m.has(a))).toBe(true);
    expect(m.size).toBeGreaterThan(HISTORICAL_GUARDED.length);
  });
});
