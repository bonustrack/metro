import { describe, expect, test } from 'bun:test';
import { approvalCard, lineTarget } from '../src/api/approval-card.ts';
import { approvalOf, type Approval } from '../src/api/approvals.ts';

const approval = (tool: string, input: unknown, line = 'metro://telegram-bot/t1/42'): Approval => {
  const parsed = approvalOf({ id: 'abcde', tool, preview: typeof input === 'string' ? input : JSON.stringify(input), line, requestedAt: '2026-10-16T10:00:00Z' });
  if (parsed === null) throw new Error('not an approval');
  return parsed;
};

describe('an approval reads as a card in words', () => {
  test('a new email shows who it goes to, its subject, its first lines and its file', () => {
    const card = approvalCard(approval('mcp__metro__send', {
      line: 'metro://outlook/o1/wan@mcigroup.ch',
      subject: 'Offer for the March event',
      text: 'Hi Wan, thank you for the call on Tuesday.',
      attachments: [{ upload: 'u1', name: 'Anderra offer.pdf' }, { url: 'https://example.com/x/plan.png?sig=1' }],
    }));
    expect(card).toEqual({
      station: 'outlook',
      account: 'o1',
      connector: null,
      title: 'Send an email',
      ask: 'send an email',
      fields: [{ label: 'To', value: 'wan@mcigroup.ch' }, { label: 'Subject', value: 'Offer for the March event' }],
      body: 'Hi Wan, thank you for the call on Tuesday.',
      file: { name: 'Anderra offer.pdf', size: null },
      moreFiles: 1,
      everything: [
        { label: 'text', value: 'Hi Wan, thank you for the call on Tuesday.' },
        { label: 'file 1 of 2', value: '{"upload":"u1","name":"Anderra offer.pdf"}' },
        { label: 'file 2 of 2', value: '{"url":"https://example.com/x/plan.png?sig=1"}' },
        { label: 'subject', value: 'Offer for the March event' },
        { label: 'line', value: 'metro://outlook/o1/wan@mcigroup.ch' },
      ],
    });
  });

  test('an email without a subject takes its first line, as the daemon does, and a reply has no recipient line', () => {
    const fresh = approvalCard(approval('mcp__metro__send', { line: 'metro://gmail/g1/a@b.ch', text: 'Quick question\nAre you free?' }));
    expect(fresh.fields).toEqual([{ label: 'To', value: 'a@b.ch' }, { label: 'Subject', value: 'Quick question' }]);
    const reply = approvalCard(approval('mcp__metro__send', { line: 'metro://outlook/o1/AAQk%2Fconv', text: 'Thanks!' }));
    expect(reply).toMatchObject({ title: 'Reply to an email', fields: [], body: 'Thanks!' });
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
    const preview = `{"line":"metro://outlook/o1/a@b.ch","text":"Hi","attachments":[{"data":"${head}\\n⋯ 245000 code points elided ⋯\\n${'B'.repeat(1497)}==","name":"offer.pdf"}]}`;
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
    expect(lineTarget('metro://outlook/o1/AAQk%2Fconv')).toEqual({ station: 'outlook', account: 'o1', resource: 'AAQk/conv' });
    expect(lineTarget('https://example.com')).toBeNull();
  });
});
