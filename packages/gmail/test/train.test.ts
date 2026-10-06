import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mailLine } from '@metro-labs/core/stations/mail';
import { Account, accounts } from '../src/accounts.ts';
import { handleCall } from '../src/actions.ts';
import { syncOnce } from '../src/inbound.ts';
import { capture, fakeFetch, json, message, TOKEN, USER, useFakeGoogle, type Route, type Seen } from './fake.ts';

const SELF = 'admin@snapshot.org';
const LINE = mailLine('gmail', 'g1', 'thread-1');
const PASS = 'mx.google.com; dkim=pass header.i=@example.ch header.s=s1; spf=pass smtp.mailfrom=bea@example.ch; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.ch';

let cap: ReturnType<typeof capture>;
let seen: Seen[];

function boot(routes: Route[], extra: Record<string, unknown> = {}): Account {
  const fake = fakeFetch(routes);
  seen = fake.seen;
  const acct = new Account(
    { id: 'g1', accountEmail: SELF, clientId: 'cid.apps.googleusercontent.com', clientSecret: 'sec', refreshToken: 'rt', accessToken: 'at', expiresAt: Date.now() + 3_600_000, ...extra },
    fake.fetch,
  );
  accounts.clear();
  accounts.set('g1', acct);
  return acct;
}

const call = (action: string, args: Record<string, unknown>): Promise<void> => handleCall({ op: 'call', id: 'c1', action, args });
const result = (): Record<string, unknown> => (cap.written.responses.at(-1)?.result ?? {}) as Record<string, unknown>;
const errorOf = (): string => String(cap.written.responses.at(-1)?.error ?? '');

const history = (ids: [string, string[]][], historyId = '200'): Response =>
  json({ history: ids.map(([id, labelIds]) => ({ messagesAdded: [{ message: { id, labelIds } }] })), historyId });

const full = (id: string, extra: Parameters<typeof message>[1] = {}): Route => (req) =>
  req.url === `${USER}/messages/${id}?format=full` ? json(message(id, { auth: PASS, ...extra })) : undefined;

const mimeOf = (req: Seen | undefined): string => {
  const body = req?.body ?? '';
  return body.slice(body.indexOf('Content-Type: message/rfc822'));
};

const decodedParts = (mime: string): string =>
  [...mime.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)].map((m) => Buffer.from((m[1] ?? '').replace(/\r\n/g, ''), 'base64').toString('utf8')).join('|');

beforeEach(() => {
  useFakeGoogle();
  cap = capture();
});

afterEach(() => {
  cap.restore();
});

describe('inbound mail', () => {
  test('the first sync only records where the mailbox is, then a new inbox mail becomes one event', async () => {
    const acct = boot([
      (req) => (req.url === `${USER}/profile` ? json({ emailAddress: SELF, historyId: '100' }) : undefined),
      (req) =>
        req.url.startsWith(`${USER}/history?startHistoryId=100`)
          ? history([
              ['m-new', ['INBOX', 'UNREAD']],
              ['m-draft', ['DRAFT', 'INBOX']],
              ['m-sent', ['SENT']],
              ['m-mine', ['INBOX']],
            ])
          : undefined,
      (req) => (req.url.startsWith(`${USER}/history?startHistoryId=200`) ? history([['m-new', ['INBOX']]], '300') : undefined),
      full('m-new'),
      full('m-mine', { from: SELF }),
    ]);
    expect(await syncOnce(acct)).toBe(0);
    expect(cap.written.events).toEqual([]);
    expect(acct.state.historyId).toBe('100');

    expect(await syncOnce(acct)).toBe(1);
    expect(seen.find((s) => s.url.includes('/history?'))?.url).toContain('historyTypes=messageAdded&labelId=INBOX');
    expect(seen.some((s) => s.url.includes('m-draft') || s.url.includes('m-sent'))).toBe(false);
    const [ev] = cap.written.events;
    expect(ev).toMatchObject({
      station: 'gmail',
      line: LINE,
      line_name: 'Invoice',
      from: 'metro://gmail/g1/user/bea@example.ch',
      from_name: 'Bea Muster',
      message_id: 'm-new',
      is_private: true,
      sender_verified: true,
      text: 'Subject: Invoice\n\nHello Admin,\n\nsee attached',
      payload: { from: 'bea@example.ch', to: [SELF], cc: [], subject: 'Invoice', internetMessageId: '<m-new@example.ch>' },
    });

    expect(await syncOnce(acct)).toBe(0);
    const saved = JSON.parse(readFileSync(join(String(process.env.GMAIL_STATE_DIR), 'gmail-state-g1.json'), 'utf8')) as { historyId: string; seen: string[] };
    expect(saved.historyId).toBe('300');
    expect(saved.seen).toEqual(['m-new', 'm-mine']);
  });

  test('a mail with files announces them, then reports each saved, inline data or fetched', async () => {
    const acct = boot([
      (req) => (req.url.includes('/history?') ? history([['m-f', ['INBOX']]]) : undefined),
      full('m-f', {
        cc: 'x@y.ch',
        files: [
          { name: 'invoice.pdf', mime: 'application/pdf', attachmentId: 'att-1', size: 3 },
          { name: 'note.txt', mime: 'text/plain', data: 'hi', size: 2 },
        ],
      }),
      (req) => (req.url === `${USER}/messages/m-f/attachments/att-1` ? json({ data: Buffer.from('PDF').toString('base64url'), size: 3 }) : undefined),
    ]);
    acct.state.historyId = '100';
    expect(await syncOnce(acct)).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    const [msg, ...files] = cap.written.events;
    expect(msg?.is_private).toBe(false);
    expect((msg?.payload as { attachments: unknown[] }).attachments).toEqual([
      { kind: 'file', name: 'invoice.pdf', mime: 'application/pdf', size: 3 },
      { kind: 'file', name: 'note.txt', mime: 'text/plain', size: 2 },
    ]);
    const saved = files.map((e) => e.payload as Record<string, unknown>);
    expect(saved.map((p) => p.contentType)).toEqual(['attachmentSaved', 'attachmentSaved']);
    expect(saved.map((p) => readFileSync(String(p.attachmentPath), 'utf8')).sort()).toEqual(['PDF', 'hi']);
  });

  test('automated mail is skipped, and a forged or missing Google verdict is unverified', async () => {
    const acct = boot([
      (req) => (req.url.includes('/history?') ? history([['m-list', ['INBOX']], ['m-robot', ['INBOX']], ['m-forged', ['INBOX']]]) : undefined),
      full('m-list', { headers: [{ name: 'List-Unsubscribe', value: '<https://x>' }] }),
      full('m-robot', { from: 'noreply@shop.ch' }),
      (req) =>
        req.url === `${USER}/messages/m-forged?format=full`
          ? json(message('m-forged', { auth: 'mx.google.com; dmarc=fail header.from=example.ch', headers: [{ name: 'Authentication-Results', value: PASS }] }))
          : undefined,
    ]);
    acct.state.historyId = '100';
    expect(await syncOnce(acct)).toBe(1);
    expect(cap.written.events.map((e) => [e.message_id, e.sender_verified])).toEqual([['m-forged', false]]);
  });

  test('a history id Google no longer knows starts over quietly', async () => {
    const acct = boot([
      (req) => (req.url.includes('/history?') ? json({ error: { status: 'NOT_FOUND', message: 'Requested entity was not found.' } }, 404) : undefined),
      (req) => (req.url === `${USER}/profile` ? json({ historyId: '900' }) : undefined),
    ]);
    acct.state.historyId = '100';
    expect(await syncOnce(acct)).toBe(0);
    expect(acct.state.historyId).toBeNull();
    expect(await syncOnce(acct)).toBe(0);
    expect(acct.state.historyId).toBe('900');
  });
});

describe('answering', () => {
  const thread: Route = (req) =>
    req.url.startsWith(`${USER}/threads/thread-1?format=metadata`)
      ? json({
          messages: [
            message('m1', { from: 'Bea <bea@example.ch>', to: `${SELF}, carl@example.ch`, cc: 'dora@example.ch', subject: 'Invoice' }),
            message('m2', { from: 'Bea <bea@example.ch>', to: SELF, cc: `dora@example.ch, ${SELF}`, subject: 'Re: Invoice', headers: [{ name: 'References', value: '<m1@example.ch>' }] }),
            message('d1', { labels: ['DRAFT'] }),
          ],
        })
      : undefined;
  const sent: Route = (req) => (req.method === 'POST' && req.url.startsWith(`${'https://gmail.test'}/upload/gmail/v1/users/me/messages/send`) ? json({ id: 'sent-1', threadId: 'thread-1' }) : undefined);

  test('send on a thread answers everyone on its latest mail, in the same thread', async () => {
    boot([thread, sent]);
    await call('send', { line: LINE, text: 'Thanks, all good ✓' });
    const post = seen.at(-1);
    expect(post?.url).toBe('https://gmail.test/upload/gmail/v1/users/me/messages/send?uploadType=multipart');
    expect(post?.type).toStartWith('multipart/related; boundary=');
    expect(post?.body).toContain('{"threadId":"thread-1"}');
    const mime = mimeOf(post);
    expect(mime).toContain(`From: ${SELF}\r\nTo: bea@example.ch\r\nCc: dora@example.ch\r\nSubject: Re: Invoice\r\n`);
    expect(mime).toContain('In-Reply-To: <m2@example.ch>\r\nReferences: <m1@example.ch>\r\n <m2@example.ch>\r\n');
    expect(decodedParts(mime)).toBe('Thanks, all good ✓');
    expect(result()).toMatchObject({ account: 'g1', repliedTo: 'm2', messageId: 'sent-1' });
  });

  test('reply answers only the sender of the named message, or its Reply-To', async () => {
    boot([
      (req) =>
        req.url.startsWith(`${USER}/messages/m7?format=metadata`)
          ? json(message('m7', { from: 'Bea <bea@example.ch>', to: `${SELF}, carl@example.ch`, subject: 'Offer', headers: [{ name: 'Reply-To', value: 'sales@example.ch' }] }))
          : undefined,
      sent,
    ]);
    await call('reply', { line: LINE, replyTo: 'm7', text: 'Yes' });
    const mime = mimeOf(seen.at(-1));
    expect(mime).toContain('To: sales@example.ch\r\nSubject: Re: Offer\r\n');
    expect(mime).not.toContain('Cc:');
    expect(result()).toMatchObject({ repliedTo: 'm7' });
  });

  test('files ride in one MIME message and are counted once it is sent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmail-out-'));
    writeFileSync(join(dir, 'a.pdf'), 'A');
    writeFileSync(join(dir, 'b.png'), 'B');
    boot([thread, sent]);
    await call('send', {
      line: LINE,
      text: 'here',
      attachments: [
        { path: join(dir, 'a.pdf'), mime: 'application/pdf', name: 'a.pdf' },
        { path: join(dir, 'b.png'), mime: 'image/png', name: 'Überblick.png' },
      ],
    });
    const mime = mimeOf(seen.at(-1));
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="metro_[0-9a-f]+"/);
    expect(mime).toContain('Content-Type: application/pdf; name="a.pdf"\r\nContent-Disposition: attachment; filename="a.pdf"');
    expect(mime).toContain("filename*=UTF-8''%C3%9Cberblick.png");
    expect(decodedParts(mime)).toBe('here|A|B');
    expect(result().attachments).toEqual(['file', 'image']);
  });

  test('a failed send reports no success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmail-out-'));
    writeFileSync(join(dir, 'a.pdf'), 'A');
    boot([thread, (req) => (req.method === 'POST' ? json({ error: { status: 'INVALID_ARGUMENT', message: 'bad' } }, 400) : undefined)]);
    await call('send', { line: LINE, text: 'x', attachments: [{ path: join(dir, 'a.pdf'), name: 'a.pdf' }] });
    expect(errorOf()).toContain('INVALID_ARGUMENT: bad');
    expect(cap.written.responses.at(-1)?.result).toBeUndefined();
  });

  test('send to an address line starts a new email and names its thread', async () => {
    boot([(req) => (req.method === 'POST' ? json({ id: 'new-1', threadId: 'new-thread' }) : undefined)]);
    await call('send', { line: mailLine('gmail', 'g1', 'Bea@Example.ch'), text: 'Hello Bea\nMore below', subject: 'Offer für Sie' });
    const post = seen.at(-1);
    expect(post?.body).toContain('\r\n{}\r\n');
    const mime = mimeOf(post);
    expect(mime).toContain(`From: ${SELF}\r\nTo: bea@example.ch\r\nSubject: =?UTF-8?B?${Buffer.from('Offer für Sie').toString('base64')}?=\r\n`);
    expect(mime).not.toContain('In-Reply-To');
    expect(result()).toMatchObject({ account: 'g1', messageId: 'new-1', line: mailLine('gmail', 'g1', 'new-thread') });
  });

  test('a bad address, a reply on an address line and files over 25 MB are refused before any call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmail-out-'));
    writeFileSync(join(dir, 'big.bin'), Buffer.alloc(25 * 1024 * 1024 + 1));
    boot([]);
    await call('send', { line: mailLine('gmail', 'g1', 'not@an'), text: 'x' });
    expect(errorOf()).toContain('not an email address');
    await call('reply', { line: mailLine('gmail', 'g1', 'bea@example.ch'), replyTo: 'm1', text: 'x' });
    expect(errorOf()).toContain('starts a new email');
    await call('send', { line: LINE, text: 'x', attachments: [{ path: join(dir, 'big.bin'), name: 'big.bin' }] });
    expect(errorOf()).toContain('up to 25 MB');
    expect(seen).toEqual([]);
  });
});

describe('reading', () => {
  const meta = (id: string, extra: Parameters<typeof message>[1] = {}): Route => (req) =>
    req.url.startsWith(`${USER}/messages/${id}?format=metadata`) ? json(message(id, extra)) : undefined;

  test('a query is a Gmail search with the other filters added, newest first', async () => {
    boot([
      (req) => (req.url.startsWith(`${USER}/messages?`) ? json({ messages: [{ id: 'r1', threadId: 'thread-1' }, { id: 'r2', threadId: 'other' }] }) : undefined),
      meta('r1'),
      meta('r2', { threadId: 'other', labels: ['INBOX'] }),
    ]);
    await call('read', { account: 'g1', query: 'invoice has:attachment', from: 'Bea@Example.ch', since: '2026-09-01', until: '2026-09-20', unreadOnly: true, limit: 500 });
    expect(seen[0]?.url).toBe(`${USER}/messages?q=invoice has:attachment from:bea@example.ch after:1788220800 before:1789862400 is:unread&maxResults=50`);
    expect(result()).toMatchObject({ account: 'g1', mode: 'search' });
    expect(result().messages).toEqual([
      {
        message_id: 'r1',
        line: LINE,
        from: 'bea@example.ch',
        from_name: 'Bea Muster',
        date: '2026-09-28T10:00:00.000Z',
        title: 'Invoice',
        text_preview: 'Hello Admin, see "attached"',
        has_attachments: false,
        is_read: false,
      },
      expect.objectContaining({ message_id: 'r2', is_read: true }) as unknown as Record<string, unknown>,
    ]);
  });

  test('a thread line without a query reads that thread, newest first, with the filters applied', async () => {
    boot([
      (req) =>
        req.url.startsWith(`${USER}/threads/thread-1?format=metadata`)
          ? json({ messages: [message('t1', { at: Date.parse('2026-09-01T00:00:00Z') }), message('t2', { from: 'carl@example.ch' }), message('t3', { labels: ['INBOX'] })] })
          : undefined,
    ]);
    await call('read', { line: LINE, from: 'bea@example.ch' });
    expect(result()).toMatchObject({ mode: 'filter' });
    expect((result().messages as { message_id: string }[]).map((m) => m.message_id)).toEqual(['t3', 't1']);
    await call('read', { line: LINE, unreadOnly: true, since: '2026-09-10' });
    expect((result().messages as { message_id: string }[]).map((m) => m.message_id)).toEqual(['t2']);
  });

  test('a message id returns it in full with its files saved, and leaves it unread', async () => {
    boot([
      full('r9', { html: '<p>Hello <b>Admin</b>,</p><p>see &amp; thanks</p>', files: [{ name: 'notes.txt', mime: 'text/plain', data: 'hi', size: 2 }] }),
    ]);
    await call('read', { line: LINE, messageId: 'r9' });
    const m = result().message as Record<string, unknown>;
    expect(m).toMatchObject({ message_id: 'r9', title: 'Invoice', to: [SELF], cc: [], is_read: false, has_attachments: true, text: 'Hello Admin,\n\nsee & thanks' });
    const [file] = m.attachments as Record<string, unknown>[];
    expect(file).toMatchObject({ name: 'notes.txt', mime: 'text/plain', size: 2 });
    expect(readFileSync(String(file?.local_path), 'utf8')).toBe('hi');
    expect(seen.every((s) => s.method === 'GET')).toBe(true);
  });

  test('a body Gmail keeps as an attachment is fetched before it is read', async () => {
    const m = message('r8', { html: '' });
    const payload = m.payload as { body: { data?: string; attachmentId?: string; size?: number } };
    payload.body = { attachmentId: 'big-body', size: 70_000 };
    boot([
      (req) => (req.url === `${USER}/messages/r8?format=full` ? json(m) : undefined),
      (req) => (req.url === `${USER}/messages/r8/attachments/big-body` ? json({ data: Buffer.from('<p>Long <i>letter</i></p>').toString('base64url') }) : undefined),
    ]);
    await call('read', { account: 'g1', messageId: 'r8' });
    expect((result().message as Record<string, unknown>).text).toBe('Long letter');
  });

  test('an expired access token is renewed once with the client secret, and the call goes through', async () => {
    let first = true;
    const acct = boot([
      (req) => (req.url === TOKEN ? json({ access_token: 'at-2', expires_in: 3599 }) : undefined),
      (req) => {
        if (!req.url.startsWith(`${USER}/messages?`)) return undefined;
        if (first) {
          first = false;
          return json({ error: { status: 'UNAUTHENTICATED', message: 'expired' } }, 401);
        }
        return req.auth === 'Bearer at-2' ? json({}) : undefined;
      },
    ]);
    await call('read', { account: 'g1' });
    expect(result().messages).toEqual([]);
    const refresh = new URLSearchParams(seen.find((s) => s.url === TOKEN)?.body);
    expect(Object.fromEntries(refresh)).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt', client_id: 'cid.apps.googleusercontent.com', client_secret: 'sec' });
    expect(acct.state).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt' });
  });

  test('a refused refresh says to connect again', async () => {
    const acct = boot([(req) => (req.url === TOKEN ? json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400) : undefined)], { accessToken: '', expiresAt: 0 });
    await expect(acct.token()).rejects.toThrow('connect Gmail again');
  });

  test('accounts report the mailbox and where to open it', async () => {
    boot([]);
    await call('accounts', {});
    expect(result().accounts).toEqual([{ id: 'g1', handle: SELF, url: `https://mail.google.com/mail/u/${SELF}/`, email: SELF, managed: false }]);
  });
});
