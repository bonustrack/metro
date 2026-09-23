import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Account } from '../src/accounts.ts';
import { syncOnce } from '../src/inbound.ts';
import { automatedByHeaders, automatedBySender, senderVerified, type Header } from '../src/trust.ts';
import { capture, fakeFetch, GRAPH, json, useFakeMicrosoft, type Seen } from './fake.ts';

const h = (name: string, value: string): Header => ({ name, value });
const FROM = 'bea@example.ch';

describe('is the sender who they say they are', () => {
  test('dmarc pass for the From domain is verified', () => {
    expect(senderVerified([h('Authentication-Results', 'spf=pass (sender IP is 1.2.3.4) smtp.mailfrom=example.ch; dkim=pass header.d=example.ch;dmarc=pass action=none header.from=example.ch;compauth=pass reason=100')], FROM)).toBe(true);
  });

  test('dmarc fail is not verified, whatever else passed', () => {
    expect(senderVerified([h('Authentication-Results', 'spf=pass smtp.mailfrom=evil.test; dkim=none; dmarc=fail action=quarantine header.from=example.ch;compauth=fail reason=000')], FROM)).toBe(false);
  });

  test('compauth pass for the From domain is verified even when dmarc has no policy', () => {
    expect(senderVerified([h('Authentication-Results', 'spf=pass smtp.mailfrom=example.ch; dkim=pass header.d=example.ch;dmarc=none action=none header.from=example.ch;compauth=pass reason=102')], FROM)).toBe(true);
  });

  test('spf pass alone with dmarc none is not enough', () => {
    expect(senderVerified([h('Authentication-Results', 'spf=pass smtp.mailfrom=example.ch; dkim=none; dmarc=none action=none header.from=example.ch;compauth=softpass reason=201')], FROM)).toBe(false);
  });

  test('a pass for another domain than the From one does not count', () => {
    expect(senderVerified([h('Authentication-Results', 'dmarc=pass action=none header.from=evil.test;compauth=pass reason=100')], FROM)).toBe(false);
  });

  test('mail from inside the organization is verified', () => {
    expect(senderVerified([h('X-MS-Exchange-Organization-AuthAs', 'Internal'), h('X-MS-Exchange-Organization-AuthSource', 'ZR0P278MB0001.CHEP278.PROD.OUTLOOK.COM')], FROM)).toBe(true);
  });

  test('only the topmost result counts, so a forged one further down is ignored', () => {
    expect(
      senderVerified(
        [h('Authentication-Results', 'spf=fail smtp.mailfrom=example.ch; dmarc=fail header.from=example.ch;compauth=fail'), h('Authentication-Results', 'dmarc=pass header.from=example.ch')],
        FROM,
      ),
    ).toBe(false);
  });

  test("Microsoft's own ARC result counts, anybody else's does not", () => {
    expect(senderVerified([h('ARC-Authentication-Results', 'i=1; mx.microsoft.com 1; spf=pass; dmarc=pass action=none header.from=example.ch')], FROM)).toBe(true);
    expect(senderVerified([h('ARC-Authentication-Results', 'i=1; mail.evil.test; dmarc=pass header.from=example.ch')], FROM)).toBe(false);
  });

  test('no headers at all is not verified', () => {
    expect(senderVerified([], FROM)).toBe(false);
  });
});

describe('automated mail', () => {
  test('a no-reply style sender is automated', () => {
    for (const address of ['noreply@x.ch', 'no-reply@x.ch', 'donotreply@x.ch', 'do-not-reply@x.ch', 'MAILER-DAEMON@x.ch', 'notifications@github.com', 'noreply+abc@x.ch'])
      expect(automatedBySender(address)).not.toBeNull();
    expect(automatedBySender('bea@example.ch')).toBeNull();
    expect(automatedBySender('notify-me-later@x.ch')).toBeNull();
  });

  test('mailing list, auto-reply and bulk headers are automated, a person is not', () => {
    expect(automatedByHeaders([h('List-Unsubscribe', '<mailto:x@y>')])).toBe('List-Unsubscribe');
    expect(automatedByHeaders([h('Auto-Submitted', 'auto-replied')])).toBe('Auto-Submitted: auto-replied');
    expect(automatedByHeaders([h('Auto-Submitted', 'no')])).toBeNull();
    expect(automatedByHeaders([h('Precedence', 'Bulk')])).toBe('Precedence: bulk');
    expect(automatedByHeaders([h('Precedence', 'first-class')])).toBeNull();
    expect(automatedByHeaders([])).toBeNull();
  });
});

describe('the inbox skips automated mail by default', () => {
  let cap: ReturnType<typeof capture>;
  let seen: Seen[];

  beforeEach(() => {
    useFakeMicrosoft();
    cap = capture();
  });

  afterEach(() => {
    cap.restore();
  });

  const mail = (id: string, from: string): Record<string, unknown> => ({
    id,
    conversationId: `c-${id}`,
    subject: id,
    from: { emailAddress: { address: from } },
    toRecipients: [{ emailAddress: { address: 'andy@anderra.ch' } }],
    receivedDateTime: new Date(Date.now() + 60_000).toISOString(),
    body: { contentType: 'text', content: 'hi' },
  });

  const HEADERS: Record<string, Header[]> = {
    person: [h('Authentication-Results', 'dmarc=fail header.from=example.ch')],
    list: [h('List-Unsubscribe', '<https://x>')],
    bulk: [h('Precedence', 'bulk')],
  };

  async function run(includeAutomated: boolean): Promise<Record<string, unknown>[]> {
    const fake = fakeFetch([
      (req) => (req.url.includes('delta') ? json({ value: [mail('person', 'bea@example.ch'), mail('list', 'news@shop.ch'), mail('bulk', 'offers@shop.ch'), mail('robot', 'noreply@shop.ch')], '@odata.deltaLink': `${GRAPH}/delta-2` }) : undefined),
      (req) => {
        const id = /\/me\/messages\/([a-z]+)\?\$select=internetMessageHeaders/.exec(req.url)?.[1];
        return id === undefined ? undefined : json({ internetMessageHeaders: HEADERS[id] ?? [] });
      },
    ]);
    seen = fake.seen;
    const acct = new Account({ id: 'o9', accountEmail: 'andy@anderra.ch', refreshToken: 'rt', accessToken: 'at', expiresAt: Date.now() + 3_600_000, includeAutomated }, fake.fetch);
    acct.state.deltaLink = `${GRAPH}/delta-1`;
    acct.state.syncedAt = new Date().toISOString();
    await syncOnce(acct);
    return cap.written.events;
  }

  test('only the person comes through, marked unverified, and the no-reply sender costs no header call', async () => {
    const events = await run(false);
    expect(events.map((e) => e.message_id)).toEqual(['person']);
    expect(events[0]?.sender_verified).toBe(false);
    expect(seen.some((s) => s.url.includes('/robot?'))).toBe(false);
  });

  test('includeAutomated lets everything through', async () => {
    const events = await run(true);
    expect(events.map((e) => e.message_id)).toEqual(['person', 'list', 'bulk', 'robot']);
  });
});
