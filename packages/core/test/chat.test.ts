import { describe, expect, test } from 'bun:test';
import { applyTurnEvent, chatLine, chatName, chatReplyOf, chatTitleOf, fitReply, turnEventOf, type ChatPart } from '../src/chat.ts';

describe('chat shapes', () => {
  test('a title is the first words of the message, on one line', () => {
    expect(chatTitleOf('  Plan the\n offsite  ')).toBe('Plan the offsite');
    expect(chatTitleOf('')).toBe('New chat');
    expect(chatTitleOf('x'.repeat(200))).toHaveLength(80);
  });

  test('a reply is read strictly: an unknown part or state makes it unreadable', () => {
    expect(chatReplyOf({ parts: [{ type: 'text', text: 'hi' }], state: 'done', error: null })).toEqual({ parts: [{ type: 'text', text: 'hi' }], state: 'done', error: null });
    expect(chatReplyOf({ parts: [{ type: 'html', text: 'hi' }], state: 'done' })).toBeNull();
    expect(chatReplyOf({ parts: [], state: 'maybe' })).toBeNull();
    expect(chatReplyOf({ parts: [{ type: 'tool', id: 'a b', name: 'Bash', input: '' }], state: 'done' })).toBeNull();
  });

  test('events build the parts: a part sets, a delta appends to text only, an event out of range does nothing', () => {
    let parts: ChatPart[] = [];
    parts = applyTurnEvent(parts, { t: 'part', n: 0, part: { type: 'text', text: 'Hel' } });
    parts = applyTurnEvent(parts, { t: 'delta', n: 0, d: 'lo' });
    parts = applyTurnEvent(parts, { t: 'part', n: 1, part: { type: 'tool', id: 't1', name: 'Bash', input: '{}', result: null, ok: null } });
    parts = applyTurnEvent(parts, { t: 'delta', n: 1, d: 'ignored' });
    parts = applyTurnEvent(parts, { t: 'part', n: 5, part: { type: 'text', text: 'gap' } });
    expect(parts).toEqual([{ type: 'text', text: 'Hello' }, { type: 'tool', id: 't1', name: 'Bash', input: '{}', result: null, ok: null }]);
  });

  test('a part the wire spoils still holds its place, so the parts after it are not lost', () => {
    expect(turnEventOf({ t: 'part', n: 2, part: { type: 'tool', id: 'a b', name: 'Bash' } })).toEqual({ t: 'part', n: 2, part: { type: 'text', text: '' } });
    expect(turnEventOf({ t: 'part', n: 0, part: 'nope' })).toEqual({ t: 'part', n: 0, part: { type: 'text', text: '' } });
    expect(turnEventOf({ t: 'part', n: -1, part: { type: 'text', text: 'x' } })).toBeNull();
    expect(chatName('mcp__my server__do/it')).toBe('mcp__my_server__do_it');
    expect(chatName('')).toBe('_');
    expect(chatName('é'.repeat(200))).toHaveLength(128);
  });

  test('a turn event from the wire is checked', () => {
    expect(turnEventOf({ t: 'delta', n: 0, d: 'x' })).toEqual({ t: 'delta', n: 0, d: 'x' });
    expect(turnEventOf({ t: 'delta', n: -1, d: 'x' })).toBeNull();
    expect(turnEventOf({ t: 'done', state: 'stopped' })).toEqual({ t: 'done', state: 'stopped', error: null });
    expect(turnEventOf({ t: 'eval', code: '1' })).toBeNull();
  });

  test('a reply too large to keep is shrunk, tool output first, never above the limit', () => {
    const big = 'y'.repeat(3_000);
    const parts: ChatPart[] = Array.from({ length: 200 }, (_, i) => ({ type: 'tool', id: `t${String(i)}`, name: 'Bash', input: big, result: big, ok: true }));
    const fitted = fitReply({ parts: [...parts, { type: 'text', text: 'the end' }], state: 'done', error: null }, 100_000);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(100_000);
    expect(fitted.parts.at(-1)).toEqual({ type: 'text', text: 'the end' });
  });

  test('the limit counts UTF-8 bytes, so a reply in a non-Latin script still fits what metro.box keeps', () => {
    const fitted = fitReply({ parts: [{ type: 'text', text: '鉄道'.repeat(150_000) }], state: 'done', error: null }, 100_000);
    expect(new TextEncoder().encode(JSON.stringify(fitted)).length).toBeLessThanOrEqual(100_000);
  });

  test('a chat line stays one line for a line reader, whatever the text holds', () => {
    const value = { t: 'turn', prompt: 'a\u2028b\u2029c\nd\re\u0000f\u0085g' };
    const line = chatLine(value);
    const parts = line.split(/\r?\n|\r(?!\n)|\u2028|\u2029/);
    expect(parts).toEqual([line.slice(0, -1), '']);
    expect(JSON.parse(parts[0] ?? '')).toEqual(value);
  });
});
