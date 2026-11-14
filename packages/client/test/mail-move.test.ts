import { describe, expect, test } from 'bun:test';
import type { AccountRow } from '../src/api/accounts.ts';
import {
  channelMailbox, connectorNameFor, eventsKnown, isMailStation, mailConnectors, MAIL_EVENT, moveProgress, moveStep, pickTarget, signedInMailbox,
  type Candidate, type MailboxCheck, type MoveStep, type Target,
} from '../src/api/mail-move.ts';
import type { OrgConnector } from '../src/api/org-connectors.ts';

type Held = OrgConnector['agents'][number];
type Status = Held['subscriptions'][number]['status'];

const LISA = 'agntLisa001';
const ANDY = 'andy@anderra.example';
const SERVER = 'https://mcp.outlook.piston.box/';

const held = (more: Partial<Held> = {}): Held => ({ id: LISA, readOnly: false, policy: {}, assignedAt: '', events: [], senders: ['*'], subscriptions: [], ...more });

const receiving = (status: Status | null, error: string | null = null): Held =>
  held({ events: [MAIL_EVENT], subscriptions: status === null ? [] : [{ event: MAIL_EVENT, status, error }] });

function connector(more: Partial<OrgConnector> = {}): OrgConnector {
  return {
    id: 'connMail001', name: ANDY, url: 'https://mcp.outlook.piston.box', auth: 'oauth', header: null, signIn: 'connected', server: null, verifiedAt: null, clientId: null, readOnly: false,
    policy: {}, createdAt: '2026-11-10T10:00:00.000Z', updatedAt: '', events: [], agents: [], ...more,
  };
}

const row = (fields: Record<string, string>): AccountRow => ({
  id: 'mail', allowlist: null, approvers: [], enabled: true, policy: {}, status: null, fields: Object.entries(fields).map(([label, value]) => ({ label, value })),
});

describe('which mailbox is which', () => {
  test('only Gmail and Outlook channels move', () => {
    expect(['gmail', 'outlook', 'telegram', 'whatsapp', 'webhook', ''].filter(isMailStation)).toEqual(['gmail', 'outlook']);
  });

  test('a channel names its mailbox in lower case, and a channel without an address names none', () => {
    expect(channelMailbox(row({ handle: 'Andy@Anderra.Example', email: 'ANDY@anderra.example' }))).toBe(ANDY);
    expect(channelMailbox(row({ handle: ' Andy@Anderra.Example ' }))).toBe(ANDY);
    expect(channelMailbox(row({ handle: '-', email: '-' }))).toBeNull();
    expect(channelMailbox(row({}))).toBeNull();
  });

  test('the account a server declares is the mailbox', () => {
    expect(signedInMailbox({ account: ' Andy@Anderra.Example ', instructions: 'This server is the Outlook mailbox other@anderra.example.' })).toBe(ANDY);
  });

  test('without a declared account, the one address the instructions name is the mailbox', () => {
    const sentence = `This server is the Outlook mailbox ${ANDY}. New mail arrives as the email.received event (MCP Events, webhook delivery).`;
    expect(signedInMailbox({ account: null, instructions: sentence })).toBe(ANDY);
    expect(signedInMailbox({ account: 'user-4711', instructions: sentence })).toBe(ANDY);
    expect(signedInMailbox({ account: null, instructions: `Mailbox ${ANDY}, again ${ANDY.toUpperCase()}.` })).toBe(ANDY);
    expect(signedInMailbox({ account: null, instructions: 'The mailbox first.last+tag@mail.anderra.co.example.' })).toBe('first.last+tag@mail.anderra.co.example');
  });

  test('nothing is guessed: no address, or two different ones, is unknown', () => {
    expect(signedInMailbox({ account: null, instructions: null })).toBeNull();
    expect(signedInMailbox({ account: null, instructions: 'A mail server.' })).toBeNull();
    expect(signedInMailbox({ account: null, instructions: `The mailbox ${ANDY}. Write to help@piston.example for support.` })).toBeNull();
    expect(signedInMailbox({ account: 'not an address', instructions: null })).toBeNull();
  });
});

describe('the connector of a mailbox', () => {
  test('only connectors at the provider address count, the oldest first', () => {
    const newer = connector({ id: 'connNewer01', createdAt: '2026-11-11T10:00:00.000Z' });
    const older = connector({ id: 'connOlder01', createdAt: '2026-11-09T10:00:00.000Z' });
    const elsewhere = connector({ id: 'connOther01', url: 'https://mcp.gmail.piston.box' });
    const broken = connector({ id: 'connBroke01', url: 'Address withheld' });
    expect(mailConnectors([newer, elsewhere, older, broken], SERVER).map((one) => one.id)).toEqual(['connOlder01', 'connNewer01']);
    expect(mailConnectors([newer], 'https://mcp.outlook.piston.box/mcp').map((one) => one.id)).toEqual(['connNewer01']);
    expect(mailConnectors([newer], 'not an address')).toEqual([]);
  });

  test('a new connector is named after its mailbox, within the 64 characters a name may have', () => {
    expect(connectorNameFor(ANDY)).toBe(ANDY);
    expect(connectorNameFor(`${'a'.repeat(70)}@anderra.example`)).toHaveLength(64);
  });

  test('none at the address: one is created', () => {
    expect(pickTarget(ANDY, [])).toBeNull();
  });

  test('a connector signed in to the mailbox is reused, whatever its name', () => {
    const renamed = connector({ id: 'connRenamed', name: 'Office mail' });
    const named = connector({ id: 'connNamed01', signIn: 'disconnected' });
    const picked = pickTarget(ANDY, [{ connector: named, listing: { mailbox: null } }, { connector: renamed, listing: { mailbox: ANDY } }]);
    expect(picked).toEqual({ connector: renamed, check: { kind: 'match' } });
  });

  test('nothing is decided while a signed-in connector at the address is still being read', () => {
    const named = connector({ id: 'connNamed01', signIn: 'disconnected' });
    const unread = connector({ id: 'connUnread1', name: 'Office mail' });
    expect(pickTarget(ANDY, [{ connector: named, listing: 'loading' }, { connector: unread, listing: 'loading' }])).toBe('checking');
    expect(pickTarget(ANDY, [{ connector: unread, listing: 'loading' }])).toBe('checking');
  });

  test('the connector named after the mailbox is reused, with what is known about its sign-in', () => {
    const cases: [Candidate, MailboxCheck][] = [
      [{ connector: connector({ signIn: 'disconnected' }), listing: 'loading' }, { kind: 'signed-out' }],
      [{ connector: connector({ signIn: null, auth: 'none' }), listing: 'loading' }, { kind: 'signed-out' }],
      [{ connector: connector(), listing: { mailbox: null } }, { kind: 'unknown' }],
      [{ connector: connector(), listing: 'failed' }, { kind: 'unreadable' }],
      [{ connector: connector(), listing: { mailbox: 'fabien@anderra.example' } }, { kind: 'other', address: 'fabien@anderra.example' }],
      [{ connector: connector({ name: ' ANDY@Anderra.Example ' }), listing: { mailbox: null } }, { kind: 'unknown' }],
    ];
    for (const [candidate, check] of cases) expect(pickTarget(ANDY, [candidate])).toEqual({ connector: candidate.connector, check });
  });

  test('a connector of another mailbox is left alone, and a second one is made for this mailbox', () => {
    const other = connector({ name: 'fabien@anderra.example' });
    expect(pickTarget(ANDY, [{ connector: other, listing: { mailbox: 'fabien@anderra.example' } }])).toBeNull();
    expect(pickTarget(ANDY, [{ connector: other, listing: { mailbox: null } }])).toBeNull();
    expect(pickTarget(ANDY, [{ connector: other, listing: 'failed' }])).toBeNull();
  });

  test('whether the api knows connector events is only known from a connector', () => {
    expect(eventsKnown([])).toBeNull();
    expect(eventsKnown([connector()])).toBe(true);
    expect(eventsKnown([connector(), connector({ events: null })])).toBe(false);
  });
});

const CHECKS: MailboxCheck[] = [{ kind: 'match' }, { kind: 'signed-out' }, { kind: 'checking' }, { kind: 'unknown' }, { kind: 'unreadable' }, { kind: 'other', address: 'fabien@anderra.example' }];

const HOLDS: Record<string, Held | null> = {
  none: null,
  assigned: held(),
  pending: receiving('pending'),
  unlisted: receiving(null),
  error: receiving('error', 'The server refused the address.'),
  signedOut: receiving('signed_out'),
  active: receiving('active'),
};

const SWITCHING: Record<string, MoveStep> = {
  pending: { step: 'starting', state: 'setting_up', error: null },
  unlisted: { step: 'starting', state: 'setting_up', error: null },
  error: { step: 'starting', state: 'failed', error: 'The server refused the address.' },
  signedOut: { step: 'starting', state: 'signin', error: null },
  active: { step: 'overlap' },
};

interface Combo {
  check: MailboxCheck;
  hold: string;
  receiving: boolean;
  confirmed: boolean;
  carried: boolean;
}

function blockedBy(combo: Combo): MoveStep | null {
  const { kind } = combo.check;
  if (combo.check.kind === 'other') return { step: 'connector', need: 'wrong-mailbox', address: combo.check.address };
  if (kind === 'signed-out') return { step: 'connector', need: 'sign-in' };
  if (kind === 'checking') return { step: 'connector', need: 'checking' };
  if (kind === 'match' || combo.confirmed || combo.hold !== 'none') return null;
  return { step: 'connector', need: kind === 'unknown' ? 'confirm' : 'unreadable' };
}

function expected(combo: Combo): MoveStep {
  const blocked = blockedBy(combo);
  if (blocked !== null) return blocked;
  if (combo.hold === 'none') return { step: 'review' };
  if (combo.hold === 'assigned') return combo.receiving || !combo.carried ? { step: 'review' } : { step: 'done', mail: 'none' };
  if (combo.receiving) return SWITCHING[combo.hold] ?? { step: 'review' };
  return { step: 'done', mail: combo.hold === 'active' ? 'connector' : 'waiting' };
}

const BOOLS = [true, false];

const combos = (): Combo[] =>
  CHECKS.flatMap((check) => Object.keys(HOLDS).flatMap((hold) => BOOLS.flatMap((isReceiving) => BOOLS.flatMap((confirmed) => BOOLS.map((carried) => ({ check, hold, receiving: isReceiving, confirmed, carried }))))));

function stepOf(combo: Combo): MoveStep {
  const assignment = HOLDS[combo.hold] ?? null;
  const target: Target = { connector: connector({ agents: assignment === null ? [] : [assignment] }), check: combo.check };
  return moveStep({ receiving: combo.receiving, target, agentId: LISA, confirmed: combo.confirmed, carried: combo.carried });
}

describe('the next step, from the real state', () => {
  test('no connector yet makes one, and nothing shows while connectors are being read', () => {
    for (const isReceiving of BOOLS) {
      expect(moveStep({ receiving: isReceiving, target: null, agentId: LISA, confirmed: false, carried: false })).toEqual({ step: 'connector', need: 'create' });
      expect(moveStep({ receiving: isReceiving, target: 'checking', agentId: LISA, confirmed: true, carried: true })).toEqual({ step: 'connector', need: 'checking' });
    }
  });

  test('every combination of sign-in, assignment, event and channel leads to its step', () => {
    const all = combos();
    expect(all).toHaveLength(CHECKS.length * Object.keys(HOLDS).length * 8);
    for (const combo of all) expect({ combo, step: stepOf(combo) }).toEqual({ combo, step: expected(combo) });
  });

  test('a connector signed in to another mailbox stops the move at every point, also after it was finished', () => {
    const check: MailboxCheck = { kind: 'other', address: 'fabien@anderra.example' };
    for (const hold of Object.keys(HOLDS))
      for (const isReceiving of BOOLS)
        expect(stepOf({ check, hold, receiving: isReceiving, confirmed: true, carried: true })).toEqual({ step: 'connector', need: 'wrong-mailbox', address: 'fabien@anderra.example' });
  });

  test('a mailbox Metro cannot read is confirmed by the admin once, and an assigned connector counts as confirmed', () => {
    const check: MailboxCheck = { kind: 'unknown' };
    expect(stepOf({ check, hold: 'none', receiving: true, confirmed: false, carried: false })).toEqual({ step: 'connector', need: 'confirm' });
    expect(stepOf({ check, hold: 'none', receiving: true, confirmed: true, carried: false })).toEqual({ step: 'review' });
    expect(stepOf({ check, hold: 'assigned', receiving: true, confirmed: false, carried: true })).toEqual({ step: 'review' });
  });

  test('another agent holding the connector does not count for this agent', () => {
    const target: Target = { connector: connector({ agents: [{ ...receiving('active'), id: 'agntTony001' }] }), check: { kind: 'match' } };
    expect(moveStep({ receiving: true, target, agentId: LISA, confirmed: false, carried: false })).toEqual({ step: 'review' });
  });

  test('closing the page at any point and opening it again goes on from where the state is', () => {
    const at = (check: MailboxCheck, hold: string, isReceiving: boolean): string => {
      const step = stepOf({ check, hold, receiving: isReceiving, confirmed: false, carried: hold !== 'none' });
      return step.step === 'connector' ? `connector:${step.need}` : step.step === 'done' ? `done:${step.mail}` : step.step;
    };
    expect(at({ kind: 'signed-out' }, 'none', true)).toBe('connector:sign-in');
    expect(at({ kind: 'match' }, 'none', true)).toBe('review');
    expect(at({ kind: 'match' }, 'assigned', true)).toBe('review');
    expect(at({ kind: 'match' }, 'pending', true)).toBe('starting');
    expect(at({ kind: 'match' }, 'active', true)).toBe('overlap');
    expect(at({ kind: 'match' }, 'active', false)).toBe('done:connector');
    expect(at({ kind: 'match' }, 'signedOut', false)).toBe('done:waiting');
    expect(at({ kind: 'match' }, 'assigned', false)).toBe('done:none');
  });
});

describe('what the channel page says about a move', () => {
  const named = (assignment: Held | null): OrgConnector[] => [connector({ agents: assignment === null ? [] : [assignment] })];

  test('nothing has started without a connector named after the mailbox that this agent holds', () => {
    expect(moveProgress(ANDY, [], LISA, true)).toBe('none');
    expect(moveProgress(ANDY, named(null), LISA, true)).toBe('none');
    expect(moveProgress(ANDY, [connector({ name: 'Office mail', agents: [receiving('active')] })], LISA, true)).toBe('none');
    expect(moveProgress(ANDY, [connector({ agents: [{ ...receiving('active'), id: 'agntTony001' }] })], LISA, true)).toBe('none');
  });

  test('started, arriving twice, or moved', () => {
    expect(moveProgress(ANDY, named(held()), LISA, true)).toBe('started');
    expect(moveProgress(ANDY, named(receiving('pending')), LISA, true)).toBe('started');
    expect(moveProgress(ANDY, named(receiving('active')), LISA, true)).toBe('twice');
    expect(moveProgress(ANDY, named(receiving('active')), LISA, false)).toBe('moved');
    expect(moveProgress(ANDY, named(receiving('error')), LISA, false)).toBe('moved');
    expect(moveProgress(ANDY, named(held()), LISA, false)).toBe('started');
  });
});
