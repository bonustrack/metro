import { describe, expect, test } from 'bun:test';
import { anyoneWrites, mailEntries, mailPeople, nextSenders, withMailEntry, withoutMailEntry } from '../src/lib/connector-mail.ts';

const MAIL_ENTRY_ERROR = 'Enter an email address, or @company.com for everyone at a company.';
const MAIL_DUPLICATE = 'This address is already in the list.';

describe('who can write to an agent through a mail connector', () => {
  test('an address or a domain is added in lower case, anything else is refused with a sentence', () => {
    expect(withMailEntry([], ' Andy@Anderra.ch ')).toEqual({ next: ['andy@anderra.ch'] });
    expect(withMailEntry(['andy@anderra.ch'], '@MCIgroup.ch')).toEqual({ next: ['andy@anderra.ch', '@mcigroup.ch'] });
    expect(withMailEntry(['andy@anderra.ch'], 'ANDY@anderra.ch')).toEqual({ error: MAIL_DUPLICATE });
    for (const bad of ['', 'andy', '@', '@localhost', '*', 'a b@c.ch', '111']) expect(withMailEntry([], bad)).toEqual({ error: MAIL_ENTRY_ERROR });
  });

  test('anyone is the star or an empty list, and removing the last person means anyone again', () => {
    expect(anyoneWrites(['*'])).toBe(true);
    expect(anyoneWrites([])).toBe(true);
    expect(anyoneWrites(['a@b.ch'])).toBe(false);
    expect(mailEntries(['*'])).toEqual([]);
    expect(nextSenders(withoutMailEntry(['a@b.ch'], 'a@b.ch'))).toEqual(['*']);
    expect(nextSenders(['a@b.ch'])).toEqual(['a@b.ch']);
  });

  test('a person is the address itself, a domain says who it lets in, and nobody can approve', () => {
    expect(mailPeople(['a@b.ch', '@anderra.ch'])).toEqual([
      { id: 'a@b.ch', title: 'a@b.ch', subtitle: null, avatar: null, approves: null, link: 'mailto:a@b.ch' },
      { id: '@anderra.ch', title: '@anderra.ch', subtitle: 'Anyone with an address at anderra.ch', avatar: null, approves: null, link: null },
    ]);
  });
});
