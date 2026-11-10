import { describe, expect, test } from 'bun:test';
import { previewInput, previewMatches, previewText } from '../src/approvals/preview.ts';

const LINE = 'metro://telegram-bot/t1/1';

describe('the preview the daemon writes for its own approvals', () => {
  test('is the arguments as JSON, whole and in their own order, however long a text is', () => {
    const args = { text: 'é'.repeat(5000), line: LINE, attachments: [{ path: '/tmp/a.png' }, { data: 'QUJD', name: 'small.txt' }], nested: { b: 1, a: [true, null] } };
    expect(previewText(args)).toBe(JSON.stringify(args));
    expect(previewInput(previewText(args))).toEqual(args);
  });

  test('only the bytes of an inline file are left out, with their count, in one pass', () => {
    const data = 'QUJD'.repeat(2 * 1024 * 1024);
    const started = Date.now();
    const preview = previewText({ line: LINE, attachments: [{ data, name: 'big.bin' }] });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(preview.length).toBeLessThan(500);
    const edge = 'QUJD'.repeat(16);
    expect(previewInput(preview)).toEqual({ line: LINE, attachments: [{ data: `${edge}\n⋯ ${String(data.length - 128)} code points elided ⋯\n${edge}`, name: 'big.bin' }] });
  });
});

describe('a preview and the call that follows it', () => {
  test('match only when the call carries exactly the arguments the preview shows', () => {
    const input = { line: LINE, text: 'hi', nested: { a: [1, 2] } };
    const preview = JSON.stringify(input);
    expect(previewMatches(preview, { nested: { a: [1, 2] }, text: 'hi', line: LINE })).toBe(true);
    expect(previewMatches(preview, { ...input, text: 'hi!' })).toBe(false);
    expect(previewMatches(preview, { ...input, reply_to: 'm1' })).toBe(false);
    expect(previewMatches(preview, { line: LINE, text: 'hi' })).toBe(false);
    for (const unreadable of ['not json', '[]', '"text"', '']) {
      expect(previewInput(unreadable)).toBeUndefined();
      expect(previewMatches(unreadable, {})).toBe(false);
    }
  });
});
