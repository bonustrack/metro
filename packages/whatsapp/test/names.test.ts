import { describe, expect, test } from 'bun:test';
import { makeNameBook, phoneOf } from '../src/names.ts';

describe('who a WhatsApp id is', () => {
  test('the phone number of a mapped id, never of a lid or a group', () => {
    expect(phoneOf('41791234567@s.whatsapp.net')).toBe('+41791234567');
    expect(phoneOf('41791234567:12@s.whatsapp.net')).toBe('+41791234567');
    expect(phoneOf('183103582650419@lid')).toBeUndefined();
    expect(phoneOf('12036@g.us')).toBeUndefined();
    expect(phoneOf(null)).toBeUndefined();
  });

  test('the last name a person used is kept, blanks are ignored', () => {
    const book = makeNameBook();
    book.note('1@lid', 'Ada');
    book.note('1@lid', '  ');
    book.note('2@lid', undefined);
    expect(book.get('1@lid')).toBe('Ada');
    expect(book.get('2@lid')).toBeUndefined();
    book.note('1@lid', 'Ada L');
    expect(book.get('1@lid')).toBe('Ada L');
  });
});

describe('names kept on disk', () => {
  test('a name learned once is there after a restart, and goes with the account', async () => {
    const { mkdtempSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { makeNameBook: book } = await import('../src/names.ts');
    const file = join(mkdtempSync(join(tmpdir(), 'wa-names-')), 'whatsapp-names-a1.json');
    const first = book(file);
    first.note('1@lid', 'Ada');
    await new Promise((r) => setTimeout(r, 2300));
    expect(existsSync(file)).toBe(true);
    expect(book(file).get('1@lid')).toBe('Ada');
  });
});
