import { describe, expect, test } from 'bun:test';
import type { AccountRow } from '@metro-labs/client/api/accounts';
import type { GroupedTool, ToolPolicy } from '@metro-labs/client/api/policy';
import type { SenderCard } from '@metro-labs/client/api/senders';
import { entriesOf, peopleOf } from '../src/lib/channel-people.ts';
import { channelSummary, type ChannelFacts } from '../src/lib/channel-summary.ts';
import { paragraph, plainText, rulesClause, txt, val } from '../src/lib/rule-sentence.ts';

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

const LABELS: Record<string, string> = { whatsapp: 'WhatsApp', gmail: 'Gmail', webhook: 'Webhook', 'telegram-bot': 'Telegram bot' };
const TOOLS: Record<string, GroupedTool[]> = { whatsapp: WHATSAPP, gmail: MAIL, outlook: MAIL, webhook: [] };

function facts(station: string, extra: Partial<AccountRow> = {}, more: Partial<ChannelFacts> = {}): ChannelFacts {
  const account = row(extra);
  const entries = entriesOf(account.allowlist);
  return {
    agent: 'Lisa',
    station,
    label: LABELS[station] ?? station,
    row: account,
    tools: TOOLS[station] ?? MESSAGING,
    verbs: station === 'webhook' ? [] : VERBS,
    people: peopleOf({ station, entries, approvers: account.approvers, cards: CARDS, seen: [], technical: false }),
    reportsStatus: station === 'whatsapp',
    pairAgain: station === 'whatsapp',
    readOnly: false,
    ...more,
  };
}

const summary = (station: string, extra: Partial<AccountRow> = {}, more: Partial<ChannelFacts> = {}): string => plainText(channelSummary(facts(station, extra, more)));

describe('who can write', () => {
  test('anyone, with approvals only on metro.box', () => {
    expect(summary('telegram-bot')).toBe('Anyone can write. Approvals only on metro.box. Lisa reads, sends and deletes freely.');
  });

  test('a few people are named', () => {
    expect(summary('telegram-bot', { allowlist: NAMED })).toStartWith('Marco, Mustafa and Ana can write.');
    expect(summary('telegram-bot', { allowlist: ['marco@lid'] })).toStartWith('Marco can write.');
  });

  test('many people show two names and a count, and nameless ids are counted, never shown', () => {
    expect(summary('whatsapp', { allowlist: ELEVEN })).toStartWith('Marco, Mustafa and 9 others can write.');
    expect(summary('whatsapp', { allowlist: ['marco@lid', '4170001@lid'] })).toStartWith('Marco and 1 other can write.');
    expect(summary('whatsapp', { allowlist: ['4170001@lid', '4170002@lid'] })).toStartWith('2 people can write.');
  });

  test('an email domain reads as anyone at it, and an address keeps its small letter', () => {
    expect(summary('gmail', { allowlist: ['@anderra.ch'] })).toStartWith('Anyone at @anderra.ch can write.');
    expect(summary('gmail', { allowlist: ['andy@anderra.ch', '@mcigroup.ch'] })).toStartWith('Anyone at @mcigroup.ch and andy@anderra.ch can write.');
    expect(summary('gmail', { allowlist: ['andy@anderra.ch'] })).toStartWith('andy@anderra.ch can write.');
  });
});

describe('approvals', () => {
  test('no approvers keeps them on metro.box', () => {
    expect(summary('telegram-bot', { allowlist: NAMED })).toContain('can write. Approvals only on metro.box.');
  });

  test('approvers get them in a private chat', () => {
    expect(summary('whatsapp', { allowlist: ELEVEN, approvers: ['marco@lid', 'mustafa@lid'] })).toStartWith(
      'Marco, Mustafa and 9 others can write. Marco and Mustafa approve in a private chat.',
    );
    expect(summary('telegram-bot', { allowlist: NAMED, approvers: ['ana@lid'] })).toContain('Ana approves in a private chat.');
  });

  test('an email channel never takes them, even with approvers saved', () => {
    expect(summary('gmail', { allowlist: ['andy@anderra.ch'], approvers: ['andy@anderra.ch'] })).toBe('andy@anderra.ch can write. Approvals only on metro.box. Lisa reads and sends freely.');
  });
});

describe('what the agent may do', () => {
  const rules = (policy: ToolPolicy, tools = MESSAGING): string => summary('telegram-bot', { policy }, { tools }).split('metro.box. ')[1] ?? '';

  test('each mix of Allow, Ask and Block in words', () => {
    expect(rules({})).toBe('Lisa reads, sends and deletes freely.');
    expect(rules({ tools: { delete: 'ask' } })).toBe('Lisa reads and sends freely, asks before deleting.');
    expect(rules({ write: 'ask' })).toBe('Lisa reads freely, asks before sending or deleting.');
    expect(rules({ write: 'ask', tools: { delete: 'deny' } })).toBe('Lisa reads freely, asks before sending, cannot delete.');
    expect(rules({ tools: { delete: 'deny' } })).toBe('Lisa reads and sends freely, cannot delete.');
    expect(rules({ read: 'ask', write: 'deny' })).toBe('Lisa asks before reading, cannot send or delete.');
    expect(rules({ read: 'deny', write: 'deny' })).toBe('Lisa cannot read, send or delete.');
    expect(rules({ read: 'ask', write: 'ask' })).toBe('Lisa asks before reading, sending or deleting.');
  });

  test('a channel without delete tools has no Delete words', () => {
    expect(rules({ write: 'ask' }, MAIL)).toBe('Lisa reads freely, asks before sending.');
  });

  test('tool by tool exceptions are named, three at most', () => {
    expect(summary('whatsapp', { policy: { tools: { create_group: 'deny' } } })).toEndWith('Lisa reads, sends and deletes freely. Exception: Create groups blocked.');
    expect(summary('whatsapp', { policy: { tools: { create_group: 'deny', ask: 'ask' } } })).toEndWith('Exceptions: Create groups blocked, Ask with a poll needs approval.');
    const many = summary('whatsapp', { policy: { write: 'ask', tools: { create_group: 'deny', ask: 'allow', react: 'allow', typing: 'allow' } } });
    expect(many).toEndWith('Exceptions: React allowed, Typing allowed and 2 more.');
  });

  test('delete tools with different rules are listed as exceptions', () => {
    expect(summary('whatsapp', { policy: { tools: { delete: 'deny', remove_members: 'ask' } } })).toEndWith(
      'Lisa reads, sends and deletes freely. Exceptions: Delete messages blocked, Remove people from groups needs approval.',
    );
  });
});

describe('receiving, the connection and stations without people', () => {
  test('Receive messages off says the agent still sends, and approvals stay on metro.box', () => {
    expect(summary('telegram-bot', { enabled: false, allowlist: NAMED, approvers: ['ana@lid'] })).toBe(
      'Lisa gets no new messages, but can still send. Approvals only on metro.box. Lisa reads, sends and deletes freely.',
    );
    expect(summary('telegram-bot', { enabled: false, policy: { write: 'deny' } })).toStartWith('Lisa gets no new messages. Approvals');
  });

  test('a logged out WhatsApp leads, and a connected one says nothing', () => {
    expect(summary('whatsapp', { status: { state: 'logged_out', since: NOW } })).toStartWith('WhatsApp is logged out: pair it again. Anyone can write.');
    expect(summary('whatsapp', { status: { state: 'disconnected', since: NOW } })).toStartWith('WhatsApp is disconnected. Anyone');
    expect(summary('whatsapp', { status: { state: 'connecting', since: NOW } })).toStartWith('WhatsApp is reconnecting. Anyone');
    expect(summary('whatsapp', { status: { state: 'connected', since: NOW } })).toStartWith('Anyone can write.');
    expect(summary('whatsapp', { status: { state: 'logged_out', since: NOW } }, { pairAgain: false })).toStartWith('WhatsApp is logged out. Anyone');
  });

  test('a webhook only receives', () => {
    expect(summary('webhook', { allowlist: null })).toBe('Lisa only receives messages and cannot write.');
  });

  test('a read-only Gmail says it cannot send', () => {
    expect(summary('gmail', { allowlist: ['@anderra.ch'] }, { readOnly: true })).toBe(
      'Anyone at @anderra.ch can write. Approvals only on metro.box. Lisa reads freely. Google access is read-only, so Lisa cannot send.',
    );
  });

  test('an unknown agent name starts the sentence with a capital', () => {
    expect(summary('telegram-bot', { enabled: false }, { agent: 'the agent' })).toStartWith('The agent gets no new messages');
  });
});

describe('the values stand out from the words around them', () => {
  test('names, counts, places and rules are values, the joining words are not', () => {
    const segments = channelSummary(facts('whatsapp', { allowlist: ELEVEN, approvers: ['marco@lid', 'mustafa@lid'], policy: { tools: { delete: 'ask', remove_members: 'ask', create_group: 'deny' } } }));
    expect(segments.filter((segment) => segment.value).map((segment) => segment.text)).toEqual([
      'Marco', 'Mustafa', '9 others', 'Marco', 'Mustafa', 'private chat', 'Lisa', 'reads', 'sends', 'deleting', 'Create groups',
    ]);
    expect(segments.filter((segment) => !segment.value).map((segment) => segment.text)).toContain(' freely, asks before ');
  });

  test('the connection state and the receive switch are values', () => {
    const values = (extra: Partial<AccountRow>): string[] => channelSummary(facts('whatsapp', extra)).filter((segment) => segment.value).map((segment) => segment.text);
    expect(values({ status: { state: 'logged_out', since: NOW } })[0]).toBe('logged out');
    expect(values({ enabled: false }).slice(0, 2)).toEqual(['Lisa', 'no new messages']);
  });

  test('a paragraph closes each sentence and joins neighbours of the same kind', () => {
    expect(paragraph([[val('anyone'), txt(' can write')], null, [txt('approvals only on '), val('metro.box')]])).toEqual([
      val('Anyone'), txt(' can write. Approvals only on '), val('metro.box'), txt('.'),
    ]);
  });

  test('nothing set says nothing', () => {
    expect(rulesClause({}, { read: { does: 'reads', ask: 'reading', cannot: 'read' }, write: { does: 'sends', ask: 'sending', cannot: 'send' }, delete: { does: 'deletes', ask: 'deleting', cannot: 'delete' } })).toBeNull();
  });
});
