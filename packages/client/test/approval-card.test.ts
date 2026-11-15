import { describe, expect, test } from 'bun:test';
import { approvalCard, lineTarget } from '../src/api/approval-card.ts';
import { approvalOf, type Approval } from '../src/api/approvals.ts';

const approval = (tool: string, input: unknown, line = 'metro://telegram-bot/t1/42'): Approval => {
  const parsed = approvalOf({ id: 'abcde', tool, preview: typeof input === 'string' ? input : JSON.stringify(input), line, requestedAt: '2026-10-16T10:00:00Z' });
  if (parsed === null) throw new Error('not an approval');
  return parsed;
};

describe('an approval reads as a card in words', () => {
  test('a send waiting on a mail channel of an older box reads as a plain message', () => {
    const card = approvalCard(approval('mcp__metro__send', {
      line: 'metro://outlook/o1/wan@mcigroup.ch',
      subject: 'Offer for the March event',
      text: 'Hi Wan, thank you for the call on Tuesday.',
      attachments: [{ upload: 'u1', name: 'Anderra offer.pdf' }, { url: 'https://example.com/x/plan.png?sig=1' }],
    }));
    expect(card).toMatchObject({
      station: 'outlook',
      account: 'o1',
      title: 'Send a message',
      fields: [],
      body: 'Hi Wan, thank you for the call on Tuesday.',
      file: { name: 'Anderra offer.pdf', size: null },
      moreFiles: 1,
    });
    expect(card.everything).toContainEqual({ label: 'subject', value: 'Offer for the March event' });
  });

  test('a chat message shows its text, a reaction its emoji, and an inline file its size', () => {
    expect(approvalCard(approval('mcp__metro__send', { line: 'metro://telegram-bot/t1/-100', text: 'Hello', attachments: [{ data: 'aGVsbG8=', name: 'hi.txt' }] }))).toMatchObject({
      station: 'telegram-bot', title: 'Send a message', fields: [], body: 'Hello', file: { name: 'hi.txt', size: '5 B' },
    });
    expect(approvalCard(approval('mcp__metro__react', { line: 'metro://whatsapp/w1/x', message_id: 'm1', emoji: '👍' }))).toMatchObject({ title: 'React to a message', body: '👍', fields: [] });
  });

  test('another metro tool shows its arguments as lines', () => {
    expect(approvalCard(approval('mcp__metro__create_group', { station: 'xmtp', account: 'x1', name: 'Team', members: ['a'] }))).toMatchObject({
      station: 'xmtp', account: 'x1', title: 'Create a group', fields: [{ label: 'Name', value: 'Team' }], body: null,
    });
  });

  test('a connector tool names the connector, from the plugin or from mcp.metro.box', () => {
    expect(approvalCard(approval('mcp__plugin_metro_notion__notion-search', { query: 'March offer' }))).toMatchObject({
      connector: 'notion', title: 'Notion search', ask: 'use Notion search on notion', fields: [{ label: 'Query', value: 'March offer' }],
    });
    expect(approvalCard(approval('granola.list_meetings', { limit: 5 }))).toMatchObject({ connector: 'granola', title: 'List meetings', fields: [{ label: 'Limit', value: '5' }] });
    expect(approvalCard(approval('Google_Drive.search', { q: 'offer' }))).toMatchObject({ connector: 'Google_Drive', title: 'Search' });
    expect(approvalCard(approval('my-crm_2.find_contact', {}))).toMatchObject({ connector: 'my-crm_2', title: 'Find contact' });
  });

  test('a file Claude Code shortened still shows its size, counted from the elided part', () => {
    const head = `data:application/pdf;base64,${'A'.repeat(1971)}`;
    const preview = `{"line":"metro://telegram-bot/t1/42","text":"Hi","attachments":[{"data":"${head}\\n⋯ 245000 code points elided ⋯\\n${'B'.repeat(1497)}==","name":"offer.pdf"}]}`;
    const parsed = approval('mcp__metro__send', preview);
    expect(parsed.fileBytes).toEqual([Math.floor(((1971 + 245000 + 1499) * 3) / 4) - 2]);
    expect(approvalCard(parsed).file).toEqual({ name: 'offer.pdf', size: '182 KB' });
    expect(parsed.input?.attachments).toEqual([{ data: `${head}…${'B'.repeat(1497)}==`, name: 'offer.pdf' }]);
  });

  test('a file sent by upload, url or path has no size the page can know', () => {
    expect(approval('mcp__metro__send', { line: 'metro://telegram-bot/t1/1', attachments: [{ upload: 'u1' }, { path: '/tmp/a.txt' }] }).fileBytes).toEqual([null, null]);
  });

  test('an unknown shape keeps the tool name and a short preview', () => {
    expect(approvalCard(approval('Bash', 'rm -rf /tmp/x'))).toMatchObject({ title: 'Bash', ask: 'approve Bash', fields: [], body: 'rm -rf /tmp/x' });
    expect(approvalCard(approval('Bash', { command: 'ls' }))).toMatchObject({ title: 'Bash', fields: [{ label: 'Command', value: 'ls' }] });
  });

  test('a channel approval lists everything the call carries: a payment card, a frame, each file with its source, any other argument', () => {
    const wallet = { type: 'walletSendCalls', content: { description: 'x'.repeat(900), to: '0xabc', value: '5000' } };
    const card = approvalCard(approval('mcp__metro__send', {
      line: 'metro://xmtp/x1/conv',
      text: `see you at noon${' '.repeat(700)}\nTHEN: wire 5000 EUR`,
      zz: 'extra',
      attachments: [{ path: '/home/agent/.ssh/id_ed25519', name: 'holiday.png' }, { data: 'A'.repeat(4000), name: 'b.bin' }],
      frame: { widget: { type: 'Card' } },
      reply_to: 'm1',
      wallet,
    }));
    expect(card).toMatchObject({ title: 'Send a message', file: { name: 'holiday.png', size: null }, moreFiles: 1 });
    expect(card.everything).toEqual([
      { label: 'text', value: 'see you at noon THEN: wire 5000 EUR' },
      { label: 'file 1 of 2', value: '{"path":"/home/agent/.ssh/id_ed25519","name":"holiday.png"}' },
      { label: 'file 2 of 2', value: '{"data":"inline data","name":"b.bin"}' },
      { label: 'wallet', value: JSON.stringify(wallet) },
      { label: 'frame', value: '{"widget":{"type":"Card"}}' },
      { label: 'reply_to', value: 'm1' },
      { label: 'line', value: 'metro://xmtp/x1/conv' },
      { label: 'zz', value: 'extra' },
    ]);
    expect(approvalCard(approval('mcp__metro__add_members', { line: 'metro://xmtp/x1/g', members: ['0x1', '0x2'] })).everything).toContainEqual({ label: 'members', value: '0x1, 0x2' });
    expect(approvalCard(approval('Bash', 'rm -rf /tmp/x')).everything).toEqual([]);
  });

  test('a metro line splits into station, account and the resource', () => {
    expect(lineTarget('metro://xmtp/x1/conv%2Fa')).toEqual({ station: 'xmtp', account: 'x1', resource: 'conv/a' });
    expect(lineTarget('https://example.com')).toBeNull();
  });
});

describe('who asked for an approval', () => {
  const of = (requestedBy: unknown): string | null => approvalOf({ id: 'abcde', tool: 'notion.create_page', preview: '{}', line: '', requestedBy })?.requestedBy ?? null;

  test('is read as plain text when the box sends it, and absent from an older box', () => {
    expect(of('access key "Claude Code"')).toBe('access key "Claude Code"');
    expect(of('an access key')).toBe('an access key');
    expect(approvalOf({ id: 'abcde', tool: 'Bash', preview: '' })?.requestedBy).toBeNull();
  });

  test('a value that is not text, or only blanks, is ignored; control and direction marks go; a long one is cut', () => {
    for (const bad of [42, null, {}, ['x'], true, '', '   ', '\n\t​']) expect(of(bad)).toBeNull();
    expect(of('access key "Lap\ntop‮"')).toBe('access key "Lap top "');
    expect(of('\u{1F469}‍\u{1F4BB} laptop')).toBe('\u{1F469}‍\u{1F4BB} laptop');
    const long = of(`access key "${'k'.repeat(500)}"`) ?? '';
    expect(long).toHaveLength(100);
    const emoji = of('\u{1F600}'.repeat(80)) ?? '';
    expect(emoji.length).toBeLessThanOrEqual(100);
    expect(emoji.endsWith('\u{1F600}…')).toBe(true);
    expect(long.endsWith('k…')).toBe(true);
  });
});
