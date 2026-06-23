/**
 * Tests for typed content events on the wire (#2).
 *
 * The canonical content-type now rides the envelope as `event` (a {@link WireEvent}):
 * a station emits it, the dispatcher (`trainEventToMetroEvent`) carries it
 * verbatim onto `MetroEvent.event`, and the emit wrapper prefers it over the
 * legacy `classifyEvent` regex (`entry.event ?? classifyEvent(entry)`).
 *
 * Covers:
 *  - per-station round-trip: emit react/edit/reply → entry has the typed `event`
 *    AND keeps the legacy text encoding;
 *  - legacy parity: an envelope WITHOUT `event` classifies exactly as before;
 *  - shared shape / no drift: `WireEvent` === `StructuredEvent`, and both wire
 *    type definitions accept the same `event` value.
 *
 * In-process; METRO_FROM pinned so `userSelf()`/`classifyEvent` are deterministic.
 */

import { describe, expect, test, beforeAll } from 'bun:test';
import type { TrainEvent } from '../src/daemon/protocol.ts';
import type { StructuredEvent, WireEvent, MetroEvent } from '../src/daemon/events.ts';

let trainEventToMetroEvent: typeof import('../src/daemon/http.ts').trainEventToMetroEvent;
let classifyEvent: typeof import('../src/daemon/events.ts').classifyEvent;

beforeAll(async () => {
  process.env.METRO_FROM = 'metro://user/me';
  ({ trainEventToMetroEvent } = await import('../src/daemon/http.ts'));
  ({ classifyEvent } = await import('../src/daemon/events.ts'));
});

/** Mirror the dispatcher emit wrapper: typed event wins, classify is the fallback. */
const resolved = (e: MetroEvent): StructuredEvent => e.event ?? classifyEvent(e);

describe('typed event carried verbatim through the dispatcher', () => {
  test('react: typed event survives + legacy [react] text kept', () => {
    const env: TrainEvent = {
      line: 'metro://discord/1', kind: 'react', emoji: '👍',
      text: '[react 👍]', event: { type: 'react', emoji: '👍', targetId: 'mid-1' },
    };
    const e = trainEventToMetroEvent(env, 'discord')!;
    expect(e.event).toEqual({ type: 'react', emoji: '👍', targetId: 'mid-1' });
    expect(e.text).toBe('[react 👍]');
    expect(resolved(e)).toEqual({ type: 'react', emoji: '👍', targetId: 'mid-1' });
  });

  test('edit: typed event survives end-to-end', () => {
    const env: TrainEvent = {
      line: 'metro://telegram/1', kind: 'edit', text: 'fixed typo',
      event: { type: 'edit', targetId: 'mid-9' },
    };
    const e = trainEventToMetroEvent(env, 'telegram')!;
    expect(e.event).toEqual({ type: 'edit', targetId: 'mid-9' });
    expect(e.text).toBe('fixed typo');
    expect(resolved(e)).toEqual({ type: 'edit', targetId: 'mid-9' });
  });

  test('reply: typed event survives + reply_to still maps to replyTo', () => {
    const env: TrainEvent = {
      line: 'metro://xmtp/a/c', text: 'sure', reply_to: 'mid-3',
      event: { type: 'reply', replyTo: 'mid-3' },
    };
    const e = trainEventToMetroEvent(env, 'xmtp')!;
    expect(e.event).toEqual({ type: 'reply', replyTo: 'mid-3' });
    expect(e.replyTo).toBe('mid-3');
    expect(resolved(e)).toEqual({ type: 'reply', replyTo: 'mid-3' });
  });

  test('delete: the new branch is carried (not derivable from text)', () => {
    const env: TrainEvent = {
      line: 'metro://discord/1', event: { type: 'delete', targetId: 'mid-7' },
    };
    const e = trainEventToMetroEvent(env, 'discord')!;
    expect(e.event).toEqual({ type: 'delete', targetId: 'mid-7' });
    expect(resolved(e)).toEqual({ type: 'delete', targetId: 'mid-7' });
  });
});

describe('legacy parity — no `event` on the wire classifies exactly as before', () => {
  test('absent event ⇒ entry.event is undefined (key omitted on the wire)', () => {
    const e = trainEventToMetroEvent({ line: 'metro://discord/1', text: 'hi' }, 'discord')!;
    expect(e.event).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain('"event"');
  });

  test('legacy [react X] text still classifies as react (regex fallback)', () => {
    const e = trainEventToMetroEvent({ line: 'metro://discord/1', emoji: '🎉' }, 'discord')!;
    expect(e.event).toBeUndefined();
    expect(e.text).toBe('[react 🎉]');
    expect(resolved(e)).toEqual({ type: 'react', emoji: '🎉', targetId: undefined });
  });

  test('legacy reply (reply_to, no event) classifies as reply', () => {
    const e = trainEventToMetroEvent({ line: 'metro://discord/1', text: 'yo', reply_to: 'mid-2' }, 'discord')!;
    expect(e.event).toBeUndefined();
    expect(resolved(e)).toEqual({ type: 'reply', replyTo: 'mid-2' });
  });

  test('legacy plain message classifies as msg', () => {
    const e = trainEventToMetroEvent({ line: 'metro://discord/1', text: 'plain' }, 'discord')!;
    expect(resolved(e)).toEqual({ type: 'msg' });
  });

  test('legacy webhook classifies as system (regex fallback unchanged)', () => {
    const e = trainEventToMetroEvent({
      line: 'metro://webhook/gh', station: 'webhook', from: 'metro://webhook/gh',
      text: 'push POST /x', payload: { headers: { 'x-github-event': 'push' } },
    }, 'webhook')!;
    expect(e.event).toBeUndefined();
    expect(resolved(e)).toEqual({ type: 'system', source: 'webhook', eventName: 'push' });
  });
});

describe('shared shape — no envelope drift', () => {
  test('WireEvent and StructuredEvent are the same type (assignable both ways)', () => {
    const a: WireEvent = { type: 'react', emoji: '👍' };
    const b: StructuredEvent = a;
    const c: WireEvent = b;
    expect(c).toBe(a);
  });

  test('one event value satisfies both wire envelope definitions', () => {
    const ev: WireEvent = { type: 'edit', targetId: 'm' };
    const fromProtocol: TrainEvent = { line: 'metro://x/1', event: ev };
    expect(fromProtocol.event).toBe(ev);
    /** And it lands on the entry verbatim through the dispatcher. */
    const e = trainEventToMetroEvent(fromProtocol, 'x')!;
    expect(e.event).toBe(ev);
  });
});
