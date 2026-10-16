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
  });

  test('an unknown shape keeps the tool name and a short preview', () => {
    expect(approvalCard(approval('Bash', 'rm -rf /tmp/x'))).toMatchObject({ title: 'Bash', ask: 'approve Bash', fields: [], body: 'rm -rf /tmp/x' });
    expect(approvalCard(approval('Bash', { command: 'ls' }))).toMatchObject({ title: 'Bash', fields: [{ label: 'Command', value: 'ls' }] });
  });

  test('a long string Claude Code elided still parses, with a mark where text was cut', () => {
    const preview = '{"line":"metro://telegram-bot/t1/1","text":"Start of the note\\n⋯ 1200 code points elided ⋯\\nend of the note"}';
    expect(approvalCard(approval('mcp__metro__send', preview)).body).toBe('Start of the note…end of the note');
    const cut = '{"line":"metro://telegram-bot/t1/1","text":"short",\n⋯ 2 field(s) elided ⋯';
    expect(approvalCard(approval('mcp__metro__send', cut))).toMatchObject({ station: 'telegram-bot', body: 'short' });
  });

  test('a metro line splits into station, account and the resource', () => {
    expect(lineTarget('metro://outlook/o1/AAQk%2Fconv')).toEqual({ station: 'outlook', account: 'o1', resource: 'AAQk/conv' });
    expect(lineTarget('https://example.com')).toBeNull();
  });
});
