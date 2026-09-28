import { describe, expect, test } from 'bun:test';
import { peopleOf, personOf } from '../src/message.ts';
import { buildMime } from '../src/mime.ts';
import { recipientsOf, replySubject } from '../src/outbound.ts';
import { senderVerified } from '../src/trust.ts';
import { message } from './fake.ts';

const h = (value: string): { name: string; value: string } => ({ name: 'Authentication-Results', value });
const FROM = 'bea@example.ch';

describe('is the sender who they say they are', () => {
  test("Google's dmarc pass for the From domain is verified", () => {
    expect(senderVerified([h('mx.google.com; dkim=pass header.i=@example.ch; spf=pass; dmarc=pass (p=REJECT) header.from=example.ch')], FROM)).toBe(true);
  });

  test('an aligned DKIM pass counts when the domain publishes no DMARC policy, SPF alone does not', () => {
    expect(senderVerified([h('mx.google.com; dkim=pass header.i=@example.ch header.s=s1; spf=pass smtp.mailfrom=example.ch; dmarc=none header.from=example.ch')], FROM)).toBe(true);
    expect(senderVerified([h('mx.google.com; dkim=pass header.i=@mailer.example.ch; spf=pass smtp.mailfrom=example.ch')], FROM)).toBe(false);
    expect(senderVerified([h('mx.google.com; dkim=pass header.i=@sendgrid.net; spf=pass smtp.mailfrom=example.ch')], FROM)).toBe(false);
  });

  test('a fail, another From domain, or a result that is not Google\'s is not verified', () => {
    expect(senderVerified([h('mx.google.com; dkim=fail; spf=fail; dmarc=fail (p=NONE) header.from=example.ch')], FROM)).toBe(false);
    expect(senderVerified([h('mx.google.com; dkim=pass header.i=@example.ch; dmarc=pass header.from=evil.test')], FROM)).toBe(false);
    expect(senderVerified([h('mail.evil.test; dmarc=pass header.from=example.ch')], FROM)).toBe(false);
    expect(senderVerified([], FROM)).toBe(false);
  });

  test('an envelope sender chosen by the attacker cannot fake a clause', () => {
    const CEO = 'ceo@victim.com';
    expect(senderVerified([h('mx.google.com; spf=pass (google.com: domain of dmarc=pass@attacker.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=dmarc=pass@attacker.com')], CEO)).toBe(false);
    const quoted = '"x;dmarc=pass header.from=victim.com;dkim=pass header.i=@victim.com;y"@attacker.com';
    expect(senderVerified([h(`mx.google.com; spf=pass (google.com: domain of ${quoted} designates 1.2.3.4 as permitted sender) smtp.mailfrom=${quoted}`)], CEO)).toBe(false);
    const spaced = '"dkim=pass header.d=victim.com x"@attacker.com';
    expect(senderVerified([h(`mx.google.com; dkim=pass header.i=@attacker.com header.s=s1; spf=pass smtp.mailfrom=${spaced}; dmarc=none header.from=victim.com`)], CEO)).toBe(false);
    expect(senderVerified([h('mx.google.com; dkim=pass header.i=@victim.com header.s=s1 header.b=AbC+/9=; spf=neutral smtp.mailfrom=x@attacker.com; dmarc=none header.from=victim.com')], CEO)).toBe(true);
  });

  test('only the topmost result counts, so a forged one further down is ignored', () => {
    expect(senderVerified([h('mx.google.com; dmarc=fail header.from=example.ch'), h('mx.google.com; dmarc=pass header.from=example.ch')], FROM)).toBe(false);
  });
});

describe('addresses', () => {
  test('names, quotes, commas inside quotes and bare addresses', () => {
    expect(personOf('"Muster, Bea" <Bea@Example.ch>')).toEqual({ address: 'bea@example.ch', name: 'Muster, Bea' });
    expect(peopleOf('"Muster, Bea" <bea@example.ch>, carl@example.ch, "A \\"B\\"" <ab@x.ch>, nobody')).toEqual([
      { address: 'bea@example.ch', name: 'Muster, Bea' },
      { address: 'carl@example.ch', name: '' },
      { address: 'ab@x.ch', name: 'A "B"' },
    ]);
  });

  test('a comment after a bare address is dropped, and nobody without an address is answered', () => {
    expect(personOf('bea@x.ch (Bea Muster)')).toEqual({ address: 'bea@x.ch', name: '' });
    expect(() => recipientsOf(message('m3', { from: 'MAILER-DAEMON', to: 'admin@snapshot.org' }), 'admin@snapshot.org', true)).toThrow('nobody');
    expect(recipientsOf(message('m4', { from: 'bea@x.ch', headers: [{ name: 'Reply-To', value: 'not-an-address' }] }), 'admin@snapshot.org', false)).toEqual({ to: ['bea@x.ch'], cc: [] });
  });

  test('reply-all to our own latest mail goes back to its recipients', () => {
    const mine = message('m1', { from: 'admin@snapshot.org', to: 'bea@example.ch', cc: 'carl@example.ch' });
    expect(recipientsOf(mine, 'admin@snapshot.org', true)).toEqual({ to: ['bea@example.ch'], cc: ['carl@example.ch'] });
    expect(() => recipientsOf(message('m2', { from: 'admin@snapshot.org', to: 'admin@snapshot.org' }), 'admin@snapshot.org', false)).toThrow('nobody');
  });

  test('a reply subject gets one Re:', () => {
    expect(replySubject('Invoice')).toBe('Re: Invoice');
    expect(replySubject('RE: Invoice')).toBe('RE: Invoice');
    expect(replySubject('')).toBe('Re:');
  });
});

describe('the MIME message', () => {
  test('a long accented subject is folded into short encoded words that read back whole, and headers cannot be injected', async () => {
    const subject = 'Réunion du comité: les échéances de fin d\'année à préparer ensemble ✓';
    const { mime } = await buildMime({ from: 'a@x.ch', to: ['b@x.ch', 'c@x.ch'], cc: [], subject: `${subject}\r\nBcc: evil@x.ch`, text: 'hi', inReplyTo: '', references: '', files: [] });
    const header = /^Subject: ([\s\S]*?)\r\n(?! )/m.exec(mime)?.[1] ?? '';
    const words = header.split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
    const decoded = words.map((w) => Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(w)?.[1] ?? '', 'base64').toString('utf8')).join('');
    expect(decoded).toBe(`${subject} Bcc: evil@x.ch`);
    expect(mime).not.toMatch(/^Bcc:/m);
    expect(mime).toContain('To: b@x.ch,\r\n c@x.ch\r\n');
  });
});
