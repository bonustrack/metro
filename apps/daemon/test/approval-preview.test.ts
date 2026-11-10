import { describe, expect, test } from 'bun:test';
import { PREVIEW_MAX, previewMatches, previewText, readPreview } from '../src/approvals/preview.ts';

const LINE = 'metro://telegram-bot/t1/1';

describe('the preview the daemon writes for its own approvals', () => {
  test('is the arguments as JSON, in their own order, and reads back whole', () => {
    const args = { text: 'hi', line: LINE, attachments: [{ path: '/tmp/a.png' }], nested: { b: 1, a: [true, null] } };
    expect(previewText(args)).toBe(JSON.stringify(args));
    expect(readPreview(previewText(args))).toEqual({ input: args, partial: false });
  });

  test('cuts only a long string, in code points, the way the page and the daemon already read a cut', () => {
    const long = `${'é'.repeat(2500)}${'😀'.repeat(2500)}`;
    const preview = previewText({ line: LINE, text: long, data: 'A'.repeat(3500), nested: [{ note: 'n'.repeat(4000) }] });
    const parsed = JSON.parse(preview) as { text: string; data: string; nested: { note: string }[] };
    expect(parsed.data).toBe('A'.repeat(3500));
    expect(parsed.text).toBe(`${'é'.repeat(1999)}\n⋯ 1502 code points elided ⋯\n${'😀'.repeat(1499)}`);
    expect(parsed.nested[0]?.note).toBe(`${'n'.repeat(1999)}\n⋯ 502 code points elided ⋯\n${'n'.repeat(1499)}`);
    expect(preview.length).toBeLessThan(PREVIEW_MAX);
    expect(previewMatches(preview, { line: LINE, text: long, data: 'A'.repeat(3500), nested: [{ note: 'n'.repeat(4000) }] })).toBe(true);
    expect(previewMatches(preview, { line: LINE, text: `${long}!`, data: 'A'.repeat(3500), nested: [{ note: 'n'.repeat(4000) }] })).toBe(false);
  });

  test('an 8 MiB inline file costs one pass, not a copy per character', () => {
    const data = 'QUJD'.repeat(2 * 1024 * 1024);
    const started = Date.now();
    const preview = previewText({ line: LINE, attachments: [{ data, name: 'big.bin' }] });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(preview.length).toBeLessThan(4000);
    expect(preview).toContain(`⋯ ${String(data.length - 3498)} code points elided ⋯`);
  });
});

describe('a preview somebody else wrote', () => {
  test('is read in a time that grows with its length, even when it is built to make the reader crawl', () => {
    const hostile = [`{${' '.repeat(300_000)}x⋯`, `{"a":1${', '.repeat(150_000)}`, `{"a":1${'\\n'.repeat(150_000)}x⋯ 1 field(s) elided ⋯`, `{${',\n'.repeat(150_000)}⋯`];
    for (const preview of hostile) {
      const started = Date.now();
      readPreview(preview);
      previewMatches(preview, { a: 1 });
      expect(Date.now() - started).toBeLessThan(1500);
    }
  });

  test('a cut left by Claude Code still reads: whole fields elided, with a real or an escaped line break', () => {
    const real = `{"line":"${LINE}","text":"short",\n⋯ 2 field(s) elided ⋯`;
    const escaped = `{"line":"${LINE}","text":"short" , \\n ⋯ 2 field(s) elided ⋯\\n}`;
    for (const preview of [real, escaped]) {
      expect(readPreview(preview)).toEqual({ input: { line: LINE, text: 'short' }, partial: true });
      expect(previewMatches(preview, { line: LINE, text: 'short', reply_to: 'm1', subject: 's' })).toBe(true);
      expect(previewMatches(preview, { line: LINE, text: 'other' })).toBe(false);
    }
    expect(readPreview('not json at all')).toEqual({ input: undefined, partial: false });
    expect(readPreview('⋯')).toEqual({ input: undefined, partial: false });
  });
});
