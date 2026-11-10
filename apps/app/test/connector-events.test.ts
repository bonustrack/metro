import { describe, expect, test } from 'bun:test';
import { CONNECTOR_EVENTS_SINCE } from '@metro-labs/client/api/connector-events';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import {
  eventRows, eventSubtitle, eventsPollMs, noServerNote, senderPeople, sendersShown, stateWords, unnamedNote, updateNote, waitsForUpdate, withEvent, type EventRow,
} from '../src/lib/connector-events.ts';

type Held = OrgConnector['agents'][number];

const LISA = 'agntLisa001';

type Offered = NonNullable<OrgConnector['events']>[number];

const CREATED: Offered = { name: 'item.created', title: 'Item created', description: 'A new item was added.', sender: true };
const UPDATED: Offered = { name: 'item.updated', title: 'Item updated', description: '', sender: false };
const MOVED: Offered = { name: 'item.moved', title: 'Item moved', description: '', sender: false };
const OFFERED = [CREATED, UPDATED];

const held = (more: Partial<Held> = {}): Held => ({ id: LISA, readOnly: false, policy: {}, assignedAt: '', events: [], senders: ['*'], subscriptions: [], ...more });

function tracker(more: Partial<Held> | null, extra: Partial<OrgConnector> = {}): OrgConnector {
  return {
    id: 'connTrack01', name: 'Tracker', url: 'https://tracker.example', auth: 'oauth', header: null, signIn: 'connected', server: null, verifiedAt: null, clientId: null, readOnly: false,
    policy: {}, createdAt: '', updatedAt: '', events: OFFERED, agents: more === null ? [] : [held(more)], ...extra,
  };
}

const rowsOf = (more: Partial<Held> | null, extra: Partial<OrgConnector> = {}): EventRow[] => eventRows(tracker(more, extra), LISA);

const row = (rows: EventRow[], name: string): EventRow => {
  const found = rows.find((one) => one.name === name);
  if (found === undefined) throw new Error(`no row ${name}`);
  return found;
};

describe('the event rows of one agent', () => {
  test('one row per offered event type, off until the agent receives it', () => {
    expect(rowsOf({})).toEqual([
      { name: 'item.created', title: 'Item created', description: 'A new item was added.', sender: true, on: false, state: null, error: null },
      { name: 'item.updated', title: 'Item updated', description: '', sender: false, on: false, state: null, error: null },
    ]);
  });

  test('nothing against an api that does not know events, a connector that offers none, or an agent without the connector', () => {
    expect(rowsOf({ events: ['item.created'] }, { events: null })).toEqual([]);
    expect(rowsOf({}, { events: [] })).toEqual([]);
    expect(rowsOf(null)).toEqual([]);
  });

  test('an event that is on shows how its subscription stands', () => {
    const rows = rowsOf({
      events: ['item.created', 'item.updated'],
      subscriptions: [{ event: 'item.created', status: 'active', error: null }, { event: 'item.updated', status: 'error', error: 'Tracker refused the address.' }],
    });
    expect(row(rows, 'item.created')).toMatchObject({ on: true, state: 'receiving', error: null });
    expect(row(rows, 'item.updated')).toMatchObject({ on: true, state: 'failed', error: 'Tracker refused the address.' });
    expect(row(rowsOf({ events: ['item.created'] }), 'item.created').state).toBe('setting_up');
    expect(row(rowsOf({ events: ['item.created'], subscriptions: [{ event: 'item.created', status: 'pending', error: null }] }), 'item.created').state).toBe('setting_up');
    expect(row(rowsOf({ events: ['item.created'], subscriptions: [{ event: 'item.created', status: 'signed_out', error: null }] }), 'item.created').state).toBe('signin');
  });

  test('a subscription left from an event that is off says nothing', () => {
    const rows = rowsOf({ subscriptions: [{ event: 'item.created', status: 'error', error: 'Old trouble.' }] });
    expect(row(rows, 'item.created')).toMatchObject({ on: false, state: null, error: null });
  });

  test('a signed out connector makes every event that is on wait for the sign-in', () => {
    const rows = rowsOf({ events: ['item.created'], subscriptions: [{ event: 'item.created', status: 'active', error: null }] }, { signIn: 'disconnected' });
    expect(row(rows, 'item.created').state).toBe('signin');
    expect(row(rows, 'item.updated').state).toBeNull();
  });

  test('an event that is on but no longer offered keeps a row, so it can be turned off', () => {
    const rows = rowsOf({ events: ['item.removed', 'item.created'] });
    expect(rows.map((one) => one.name)).toEqual(['item.created', 'item.updated', 'item.removed']);
    expect(row(rows, 'item.removed')).toEqual({ name: 'item.removed', title: 'Item removed', description: '', sender: false, on: true, state: 'gone', error: null });
    expect(rowsOf({ events: ['item.removed'] }, { events: [] }).map((one) => one.name)).toEqual(['item.removed']);
  });
});

describe('an event row in words', () => {
  const on = (state: EventRow['state'], error: string | null = null): EventRow => ({ name: 'item.created', title: 'Item created', description: 'A new item was added.', sender: true, on: state !== null, state, error });

  test('each state has a plain sentence, and only trouble is red', () => {
    expect(stateWords(on(null), 'Tracker')).toBeNull();
    expect(stateWords(on('receiving'), 'Tracker')).toEqual({ text: 'Receiving', tone: 'secondary' });
    expect(stateWords(on('setting_up'), 'Tracker')).toEqual({ text: 'Setting up: Metro is asking Tracker to send these.', tone: 'secondary' });
    expect(stateWords(on('signin'), 'Tracker')).toEqual({ text: 'Waiting for sign-in: sign in to this connector again.', tone: 'danger' });
    expect(stateWords(on('failed', 'Tracker refused the address.'), 'Tracker')).toEqual({ text: 'Tracker refused the address.', tone: 'danger' });
    expect(stateWords(on('failed'), 'Tracker')).toEqual({ text: 'Could not set this up with Tracker.', tone: 'danger' });
    expect(stateWords(on('gone'), 'Tracker')).toEqual({ text: 'Tracker does not offer this any more. Turn it off.', tone: 'danger' });
  });

  test('the subtitle is the description, with the raw name only with technical details', () => {
    expect(eventSubtitle(on(null), false)).toBe('A new item was added.');
    expect(eventSubtitle(on(null), true)).toBe('A new item was added. · item.created');
    expect(eventSubtitle({ ...on(null), description: '' }, false)).toBeUndefined();
    expect(eventSubtitle({ ...on(null), description: '' }, true)).toBe('item.created');
  });

  test('an agent without a server reads why in one sentence', () => {
    expect(noServerNote('Laptop')).toBe('Laptop has no server, so it cannot receive events, but it can still use the tools.');
  });
});

describe('an agent whose Metro is too old for events', () => {
  test('only a known version before beta.330 says that events wait for the update', () => {
    expect(CONNECTOR_EVENTS_SINCE).toBe('0.1.0-beta.330');
    expect(waitsForUpdate('0.1.0-beta.329', false)).toBe(true);
    expect(waitsForUpdate('0.1.0-beta.12', false)).toBe(true);
    expect(waitsForUpdate('0.1.0-beta.330', false)).toBe(false);
    expect(waitsForUpdate('0.1.0-beta.331', false)).toBe(false);
    expect(waitsForUpdate('0.1.0', false)).toBe(false);
  });

  test('an unknown version, one Metro cannot read or an agent without a server never shows the line', () => {
    expect(waitsForUpdate(null, false)).toBe(false);
    expect(waitsForUpdate('', false)).toBe(false);
    expect(waitsForUpdate('dev', false)).toBe(false);
    expect(waitsForUpdate('0.1.0-beta.329', true)).toBe(false);
  });

  test('the line says where the events wait, for how long, and how to update', () => {
    expect(updateNote('Lisa')).toBe("Events wait on Metro's side, 7 days at most, until Lisa's Metro is updated to 0.1.0-beta.330 or later: open Lisa's Settings, then Metro version under Server.");
  });
});

describe('reading again while a subscription settles', () => {
  test('every few seconds while one is being set up, slowly while one waits or failed, never once all receive', () => {
    expect(eventsPollMs(rowsOf({}))).toBeNull();
    expect(eventsPollMs(rowsOf({ events: ['item.created'] }))).toBe(3_000);
    expect(eventsPollMs(rowsOf({ events: ['item.created'], subscriptions: [{ event: 'item.created', status: 'active', error: null }] }))).toBeNull();
    expect(eventsPollMs(rowsOf({ events: ['item.created'], subscriptions: [{ event: 'item.created', status: 'error', error: 'No.' }] }))).toBe(15_000);
    expect(eventsPollMs(rowsOf({ events: ['item.created'] }, { signIn: 'disconnected' }))).toBe(15_000);
    expect(eventsPollMs(rowsOf({ events: ['item.created', 'item.updated'], subscriptions: [{ event: 'item.created', status: 'signed_out', error: null }] }))).toBe(3_000);
    expect(eventsPollMs(rowsOf({ events: ['item.removed'] }))).toBeNull();
  });
});

describe('turning an event on or off', () => {
  test('the wanted list gains or loses one name, keeps its order and never repeats one', () => {
    expect(withEvent([], 'item.created', true)).toEqual(['item.created']);
    expect(withEvent(['item.updated'], 'item.created', true)).toEqual(['item.updated', 'item.created']);
    expect(withEvent(['item.created'], 'item.created', true)).toEqual(['item.created']);
    expect(withEvent(['item.updated', 'item.created'], 'item.updated', false)).toEqual(['item.created']);
    expect(withEvent(['item.created'], 'item.updated', false)).toEqual(['item.created']);
  });
});

describe('who can write', () => {
  test('the list shows only once an event is on and an offered event names its sender, or the list is not anyone', () => {
    expect(sendersShown(rowsOf({}), ['*'])).toBe(false);
    expect(sendersShown(rowsOf({ events: ['item.updated'] }), ['*'])).toBe(true);
    expect(sendersShown(rowsOf({ events: ['item.updated'] }, { events: [UPDATED] }), ['*'])).toBe(false);
    expect(sendersShown(rowsOf({ events: ['item.updated'] }, { events: [UPDATED] }), ['lisa@example.org'])).toBe(true);
    expect(sendersShown(rowsOf({}), ['lisa@example.org'])).toBe(false);
  });

  test('each entry is a person or a whole domain, and nobody can approve from here', () => {
    expect(senderPeople(['*'])).toEqual([]);
    expect(senderPeople(['lisa@example.org', '@example.com'])).toEqual([
      { id: 'lisa@example.org', title: 'lisa@example.org', subtitle: null, avatar: null, approves: null, link: null },
      { id: '@example.com', title: '@example.com', subtitle: 'Anyone with an address at example.com', avatar: null, approves: null, link: null },
    ]);
  });

  test('an event that names no sender is said to be dropped while the list is not anyone', () => {
    const rows = rowsOf({ events: ['item.created', 'item.updated'] });
    expect(unnamedNote(rows, ['*'])).toBeUndefined();
    expect(unnamedNote(rows, ['lisa@example.org'])).toBe('Item updated does not say who sent it, so it is dropped unless anyone can write.');
    expect(unnamedNote(rowsOf({ events: ['item.created'] }), ['lisa@example.org'])).toBeUndefined();
    const both = rowsOf({ events: ['item.updated', 'item.moved'] }, { events: [...OFFERED, MOVED] });
    expect(unnamedNote(both, ['@example.com'])).toBe('Item updated and Item moved do not say who sent them, so they are dropped unless anyone can write.');
  });
});
