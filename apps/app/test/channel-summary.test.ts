import { describe, expect, test } from 'bun:test';
import type { AccountRow } from '@metro-labs/client/api/accounts';
import type { GroupedTool, ToolPolicy } from '@metro-labs/client/api/policy';
import type { SenderCard } from '@metro-labs/client/api/senders';
import { entriesOf, peopleOf } from '../src/lib/channel-people.ts';
import { channelSummary, type ChannelFacts } from '../src/lib/channel-summary.ts';
import { rulesClause } from '../src/lib/rule-sentence.ts';

const W = (name: string): GroupedTool => ({ name, group: 'write' });
const R = (name: string): GroupedTool => ({ name, group: 'read' });
const MESSAGING: GroupedTool[] = [W('send'), W('reply'), W('react'), W('typing'), W('delete'), R('read'), R('list_members'), R('get_profile')];
const WHATSAPP: GroupedTool[] = [...MESSAGING, W('create_group'), W('ask'), W('remove_members')];
const MAIL: GroupedTool[] = [W('send'), W('reply'), R('read')];
const VERBS = ['send', 'reply', 'react', 'delete'];

const CARDS: SenderCard[] = [
  { id: 'marco@lid', name: 'Marco' },
  { id: 'mustafa@lid', name: 'Mustafa' },
  { id: 'ana@lid', name: 'Ana' },
];
const NAMED = ['marco@lid', 'mustafa@lid', 'ana@lid'];
const ELEVEN = ['marco@lid', 'mustafa@lid', ...Array.from({ length: 9 }, (_, i) => `${String(4170000 + i)}@lid`)];
const NOW = Date.UTC(2026, 9, 23, 12);

const row = (extra: Partial<AccountRow> = {}): AccountRow => ({ id: 'acct1', allowlist: ['*'], approvers: [], enabled: true, policy: {}, status: null, fields: [], ...extra });

function facts(station: string, extra: Partial<AccountRow> = {}, more: Partial<ChannelFacts> = {}): ChannelFacts {
  const account = row(extra);
  const entries = entriesOf(account.allowlist);
  return {
    agent: 'Lisa',
    station,
    label: station === 'whatsapp' ? 'WhatsApp' : station === 'gmail' ? 'Gmail' : station === 'webhook' ? 'Webhook' : 'Telegram bot',
    row: account,
    tools: station === 'gmail' || station === 'outlook' ? MAIL : station === 'webhook' ? [] : station === 'whatsapp' ? WHATSAPP : MESSAGING,
    verbs: station === 'webhook' ? [] : VERBS,
    people: peopleOf({ station, entries, approvers: account.approvers, cards: CARDS, seen: [], technical: false }),
    reportsStatus: station === 'whatsapp',
    pairAgain: station === 'whatsapp',
    readOnly: false,
    ...more,
  };
}

const summary = (station: string, extra: Partial<AccountRow> = {}, more: Partial<ChannelFacts> = {}): string => channelSummary(facts(station, extra, more));

describe('who can write', () => {
  test('anyone, with approval questions only on metro.box', () => {
    expect(summary('telegram-bot')).toBe('Anyone can write to Lisa here, and approval questions only show on metro.box. Lisa can read, send and delete freely.');
  });

  test('a few people are named', () => {
    expect(summary('telegram-bot', { allowlist: NAMED })).toStartWith('Only Marco, Mustafa and Ana can write to Lisa here');
    expect(summary('telegram-bot', { allowlist: ['marco@lid'] })).toStartWith('Only Marco can write to Lisa here');
  });

  test('many people show two names and a count, and nameless ids are counted, never shown', () => {
    expect(summary('whatsapp', { allowlist: ELEVEN })).toStartWith('Only Marco, Mustafa and 9 others can write to Lisa here');
    expect(summary('whatsapp', { allowlist: ['marco@lid', '4170001@lid'] })).toStartWith('Only Marco and 1 other can write');
    expect(summary('whatsapp', { allowlist: ['4170001@lid', '4170002@lid'] })).toStartWith('Only 2 people can write');
  });

  test('an email domain reads as anyone at it', () => {
    expect(summary('gmail', { allowlist: ['@anderra.ch'] })).toStartWith('Anyone at @anderra.ch can write to Lisa here');
    expect(summary('gmail', { allowlist: ['andy@anderra.ch', '@mcigroup.ch'] })).toStartWith('Anyone at @mcigroup.ch and andy@anderra.ch can write');
  });
});

describe('approval questions', () => {
  test('no approvers keeps them on metro.box', () => {
    expect(summary('telegram-bot', { allowlist: NAMED })).toContain('and approval questions only show on metro.box.');
  });

  test('approvers get them in a private chat', () => {
    expect(summary('whatsapp', { allowlist: ELEVEN, approvers: ['marco@lid', 'mustafa@lid'] })).toStartWith(
      'Only Marco, Mustafa and 9 others can write to Lisa here, and approval questions go to Marco or Mustafa in a private chat.',
    );
    expect(summary('telegram-bot', { allowlist: NAMED, approvers: ['ana@lid'] })).toContain('approval questions go to Ana in a private chat.');
  });

  test('an email channel never takes them, even with approvers saved', () => {
    expect(summary('gmail', { allowlist: ['andy@anderra.ch'], approvers: ['andy@anderra.ch'] })).toBe(
      'Only andy@anderra.ch can write to Lisa here, and approval questions only show on metro.box. Lisa can read and send freely.',
    );
  });
});

describe('what the agent may do', () => {
  const rules = (policy: ToolPolicy, tools = MESSAGING): string => summary('telegram-bot', { policy }, { tools }).split('metro.box. ')[1] ?? '';

  test('each mix of Allow, Ask and Block in words', () => {
    expect(rules({})).toBe('Lisa can read, send and delete freely.');
    expect(rules({ tools: { delete: 'ask' } })).toBe('Lisa can read and send freely, but must ask before deleting.');
    expect(rules({ write: 'ask' })).toBe('Lisa can read freely, but must ask before sending or deleting.');
    expect(rules({ write: 'ask', tools: { delete: 'deny' } })).toBe('Lisa can read freely, must ask before sending, and cannot delete.');
    expect(rules({ tools: { delete: 'deny' } })).toBe('Lisa can read and send freely, but cannot delete.');
    expect(rules({ read: 'ask', write: 'deny' })).toBe('Lisa must ask before reading and cannot send or delete.');
    expect(rules({ read: 'deny', write: 'deny' })).toBe('Lisa cannot read, send or delete.');
    expect(rules({ read: 'ask', write: 'ask' })).toBe('Lisa must ask before reading, sending or deleting.');
  });

  test('a channel without delete tools has no Delete words', () => {
    expect(rules({ write: 'ask' }, MAIL)).toBe('Lisa can read freely, but must ask before sending.');
  });

  test('tool by tool exceptions are counted and named, three at most', () => {
    const one = summary('whatsapp', { policy: { tools: { create_group: 'deny' } } });
    expect(one).toEndWith('Lisa can read, send and delete freely. 1 tool has its own rule: Create groups is blocked.');
    const two = summary('whatsapp', { policy: { tools: { create_group: 'deny', ask: 'ask' } } });
    expect(two).toEndWith('2 tools have their own rule: Create groups is blocked and Ask with a poll needs approval.');
    const many = summary('whatsapp', { policy: { write: 'ask', tools: { create_group: 'deny', ask: 'allow', react: 'allow', typing: 'allow' } } });
    expect(many).toEndWith('4 tools have their own rule: React is allowed, Typing is allowed and 2 more.');
  });

  test('delete tools with different rules are listed as their own rules', () => {
    expect(summary('whatsapp', { policy: { tools: { delete: 'deny', remove_members: 'ask' } } })).toEndWith(
      'Lisa can read, send and delete freely. 2 tools have their own rule: Delete messages is blocked and Remove people from groups needs approval.',
    );
  });
});

describe('receiving, the connection and stations without people', () => {
  test('Receive messages off says the agent still sends, and questions stay on metro.box', () => {
    expect(summary('telegram-bot', { enabled: false, allowlist: NAMED, approvers: ['ana@lid'] })).toBe(
      'Lisa does not read new messages here, but can still send. Approval questions only show on metro.box. Lisa can read, send and delete freely.',
    );
    expect(summary('telegram-bot', { enabled: false, policy: { write: 'deny' } })).toStartWith('Lisa does not read new messages here. Approval');
  });

  test('a logged out WhatsApp leads, and a connected one says nothing', () => {
    const out = summary('whatsapp', { status: { state: 'logged_out', since: NOW } });
    expect(out).toStartWith('WhatsApp is logged out: pair it again. Anyone can write');
    expect(summary('whatsapp', { status: { state: 'disconnected', since: NOW } })).toStartWith('WhatsApp is disconnected. Anyone');
    expect(summary('whatsapp', { status: { state: 'connecting', since: NOW } })).toStartWith('WhatsApp is reconnecting. Anyone');
    expect(summary('whatsapp', { status: { state: 'connected', since: NOW } })).toStartWith('Anyone can write');
    expect(summary('whatsapp', { status: { state: 'logged_out', since: NOW } }, { pairAgain: false })).toStartWith('WhatsApp is logged out. Anyone');
  });

  test('a webhook only brings messages in', () => {
    expect(summary('webhook', { allowlist: null })).toBe('This channel only brings messages in, so Lisa cannot write here.');
  });

  test('a read-only Gmail says it cannot send', () => {
    expect(summary('gmail', { allowlist: ['@anderra.ch'] }, { readOnly: true })).toBe(
      'Anyone at @anderra.ch can write to Lisa here, and approval questions only show on metro.box. Lisa can read freely. Google access is read-only, so Lisa cannot send from this mailbox.',
    );
  });

  test('an unknown agent name starts the sentence with a capital', () => {
    expect(summary('telegram-bot', { enabled: false }, { agent: 'the agent' })).toStartWith('The agent does not read new messages here');
  });
});

describe('the clause joiner', () => {
  test('nothing set says nothing', () => {
    expect(rulesClause({}, { read: { can: 'read', doing: 'reading' }, write: { can: 'send', doing: 'sending' }, delete: { can: 'delete', doing: 'deleting' } })).toBeNull();
  });
});
