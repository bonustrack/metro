import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account, accounts } from '../src/accounts.ts';
import { handleCall } from '../src/actions.ts';
import { lineOf } from '../src/format.ts';
import { htmlToText } from '../src/html.ts';
import { syncOnce } from '../src/inbound.ts';
import { capture, fakeFetch, GRAPH, json, useFakeMicrosoft, type Route, type Seen } from './fake.ts';

const SELF = 'andy@anderra.ch';
const CONV = 'AAQkAD/abc+def=';
const LINE = lineOf('o1', CONV);

const message = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  conversationId: CONV,
  subject: 'Invoice',
  from: { emailAddress: { name: 'Bea Muster', address: 'Bea@Example.ch' } },
  toRecipients: [{ emailAddress: { address: SELF } }],
  ccRecipients: [],
  receivedDateTime: new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  bodyPreview: 'Hello Andy',
  body: { contentType: 'html', content: '<p>Hello <b>Andy</b>,</p><p>see attached &amp; thanks</p>' },
  hasAttachments: false,
  isRead: false,
  ...extra,
});

const DMARC_PASS = [{ name: 'Authentication-Results', value: 'spf=pass smtp.mailfrom=example.ch; dmarc=pass action=none header.from=example.ch;compauth=pass reason=100' }];
const headersRoute: Route = (req) => (req.url.endsWith('?$select=internetMessageHeaders') ? json({ internetMessageHeaders: DMARC_PASS }) : undefined);

let cap: ReturnType<typeof capture>;
let seen: Seen[];

function boot(routes: Route[]): Account {
  const fake = fakeFetch(routes);
  seen = fake.seen;
  const acct = new Account({ id: 'o1', accountEmail: SELF, refreshToken: 'rt', accessToken: 'at', expiresAt: Date.now() + 3_600_000 }, fake.fetch);
  accounts.clear();
  accounts.set('o1', acct);
  return acct;
}

const call = (action: string, args: Record<string, unknown>): Promise<void> => handleCall({ op: 'call', id: 'c1', action, args });
const result = (): Record<string, unknown> => (cap.written.responses.at(-1)?.result ?? {}) as Record<string, unknown>;
const errorOf = (): string => String(cap.written.responses.at(-1)?.error ?? '');

beforeEach(() => {
  useFakeMicrosoft();
  cap = capture();
});

afterEach(() => {
  cap.restore();
});

describe('html to text', () => {
  test('keeps the words and the paragraphs, drops tags, styles and scripts', () => {
    const html = '<html><head><style>p{color:red}</style></head><body><p>Hi&nbsp;there,</p><script>alert(1)</script><ul><li>one</li><li>two</li></ul>A&lt;B &#233;t&#xE9;</body></html>';
    expect(htmlToText(html)).toBe('Hi there,\n\n- one\n- two\nA<B été');
  });
});

describe('inbound mail', () => {
  test('the first sync only records where Outlook is, then a new mail becomes one event', async () => {
    const pages: Record<string, unknown>[] = [
      { value: [message('old-1')], '@odata.nextLink': `${GRAPH}/delta-page-2` },
      { value: [message('old-2')], '@odata.deltaLink': `${GRAPH}/delta-1` },
      { value: [message('new-1'), message('mine', { from: { emailAddress: { address: SELF } } })], '@odata.deltaLink': `${GRAPH}/delta-2` },
      { value: [message('new-1', { isRead: true })], '@odata.deltaLink': `${GRAPH}/delta-3` },
    ];
    const acct = boot([headersRoute, (req) => (req.url.includes('delta') ? json(pages.shift()) : undefined)]);
    expect(await syncOnce(acct)).toBe(0);
    expect(cap.written.events).toEqual([]);
    expect(acct.state.deltaLink).toBe(`${GRAPH}/delta-1`);
    expect(seen[0]?.url).toContain('/me/mailFolders/inbox/messages/delta?$select=');

    expect(await syncOnce(acct)).toBe(1);
    expect(seen.some((s) => s.url === `${GRAPH}/delta-1`)).toBe(true);
    const [ev] = cap.written.events;
    expect(ev).toMatchObject({
      kind: 'inbound',
      station: 'outlook',
      account: 'o1',
      line: 'metro://outlook/o1/AAQkAD%2Fabc%2Bdef=',
      line_name: 'Invoice',
      from: 'metro://outlook/o1/user/bea@example.ch',
      from_name: 'Bea Muster',
      message_id: 'new-1',
      is_private: true,
      sender_verified: true,
      text: 'Subject: Invoice\n\nHello Andy,\n\nsee attached & thanks',
    });

    expect(await syncOnce(acct)).toBe(0);
    const saved = JSON.parse(readFileSync(join(String(process.env.OUTLOOK_STATE_DIR), 'outlook-state-o1.json'), 'utf8')) as { deltaLink: string; seen: string[] };
    expect(saved.deltaLink).toBe(`${GRAPH}/delta-3`);
    expect(saved.seen).toEqual(['new-1']);
  });

  test('a mail with a file announces it, then reports it saved', async () => {
    const acct = boot([
      headersRoute,
      (req) => (req.url.includes('delta') ? json({ value: [message('m-f', { hasAttachments: true, ccRecipients: [{ emailAddress: { address: 'x@y.ch' } }] })], '@odata.deltaLink': `${GRAPH}/delta-d2` }) : undefined),
      (req) => (req.url.endsWith('/attachments?$select=id,name,contentType,size,isInline') ? json({ value: [{ '@odata.type': '#microsoft.graph.fileAttachment', id: 'att1', name: 'invoice.pdf', contentType: 'application/pdf', size: 3 }] }) : undefined),
      (req) => (req.url.endsWith('/attachments/att1/$value') ? new Response('PDF') : undefined),
    ]);
    acct.state.deltaLink = `${GRAPH}/delta-d1`;
    acct.state.syncedAt = new Date().toISOString();
    expect(await syncOnce(acct)).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    const [msg, saved] = cap.written.events;
    expect(msg?.is_private).toBe(false);
    expect((msg?.payload as { attachments: unknown[] }).attachments).toEqual([{ kind: 'file', name: 'invoice.pdf', mime: 'application/pdf', size: 3 }]);
    const payload = saved?.payload as Record<string, unknown>;
    expect(payload.contentType).toBe('attachmentSaved');
    expect(payload.attachmentFor).toBe(msg?.id);
    expect(readFileSync(String(payload.localPath), 'utf8')).toBe('PDF');
  });
});

describe('answering', () => {
  const latest: Route = (req) =>
    req.method === 'GET' && req.url.startsWith(`${GRAPH}/me/messages?`) && req.url.includes('conversationId eq') ? json({ value: [{ id: 'last-1' }] }) : undefined;
  const accepted: Route = (req) => (req.method === 'POST' ? new Response(null, { status: 202 }) : undefined);

  test('reply answers the named message and keeps line breaks', async () => {
    boot([accepted]);
    await call('reply', { line: LINE, replyTo: 'msg-7', text: 'Thanks <Bea>\nAndy' });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([`POST ${GRAPH}/me/messages/msg-7/reply`]);
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ comment: 'Thanks &lt;Bea&gt;<br>Andy' });
    expect(result()).toMatchObject({ account: 'o1', repliedTo: 'msg-7' });
  });

  test('send on a conversation answers everyone on its latest mail', async () => {
    boot([latest, accepted]);
    await call('send', { line: LINE, text: 'ok' });
    expect(seen[0]?.url).toContain(`conversationId eq '${CONV}'`);
    expect(seen[0]?.url).toContain('$orderby=receivedDateTime desc');
    expect(seen[1]?.url).toBe(`${GRAPH}/me/messages/last-1/replyAll`);
  });

  test('files go through a draft, one attachment each, and are counted as they land', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outlook-out-'));
    writeFileSync(join(dir, 'a.pdf'), 'A');
    writeFileSync(join(dir, 'b.png'), 'B');
    boot([
      latest,
      (req) => (req.url.endsWith('/createReplyAll') ? json({ id: 'draft-1' }, 201) : undefined),
      (req) => (req.url.endsWith('/draft-1/attachments') ? json({ id: 'x' }, 201) : undefined),
      accepted,
    ]);
    await call('send', {
      line: LINE,
      text: 'here',
      attachments: [
        { path: join(dir, 'a.pdf'), mime: 'application/pdf', name: 'a.pdf' },
        { path: join(dir, 'b.png'), mime: 'image/png', name: 'b.png' },
      ],
    });
    expect(seen.map((s) => s.url.replace(GRAPH, ''))).toEqual([
      expect.stringContaining('/me/messages?') as unknown as string,
      '/me/messages/last-1/createReplyAll',
      '/me/messages/draft-1/attachments',
      '/me/messages/draft-1/attachments',
      '/me/messages/draft-1/send',
    ]);
    expect(JSON.parse(seen[2]?.body ?? '')).toMatchObject({ '@odata.type': '#microsoft.graph.fileAttachment', name: 'a.pdf', contentBytes: 'QQ==' });
    expect(result().attachments).toEqual(['file', 'image']);
  });

  test('a failed attachment drops the draft and reports no success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outlook-out-'));
    writeFileSync(join(dir, 'a.pdf'), 'A');
    boot([
      (req) => (req.url.endsWith('/createReply') ? json({ id: 'draft-2' }, 201) : undefined),
      (req) => (req.url.endsWith('/draft-2/attachments') ? json({ error: { code: 'ErrorQuotaExceeded', message: 'full' } }, 400) : undefined),
      (req) => (req.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined),
    ]);
    await call('reply', { line: LINE, replyTo: 'm1', text: 'x', attachments: [{ path: join(dir, 'a.pdf'), name: 'a.pdf' }] });
    expect(errorOf()).toContain('ErrorQuotaExceeded');
    expect(seen.at(-1)).toMatchObject({ method: 'DELETE', url: `${GRAPH}/me/messages/draft-2` });
  });

  test('a file over 3 MB is refused before anything is created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outlook-out-'));
    writeFileSync(join(dir, 'big.bin'), Buffer.alloc(3 * 1024 * 1024 + 1));
    boot([]);
    await call('reply', { line: LINE, replyTo: 'm1', text: 'x', attachments: [{ path: join(dir, 'big.bin'), name: 'big.bin' }] });
    expect(errorOf()).toContain('up to 3 MB');
    expect(seen).toEqual([]);
  });
});

describe('reading', () => {
  const listed = (): Response => json({ value: [message('r1', { body: undefined }), message('r2', { conversationId: 'other', body: undefined })] });

  test('a query is a Microsoft search, and the line narrows what it found', async () => {
    boot([(req) => (req.url.includes('$search') ? listed() : undefined)]);
    await call('read', { line: LINE, query: 'invoice "march"', from: 'Bea@Example.ch' });
    expect(seen[0]?.url).toContain('$search="from:bea@example.ch invoice march"');
    expect(seen[0]?.url).not.toContain('$filter');
    expect(result()).toMatchObject({ account: 'o1', mode: 'search' });
    expect(result().messages).toEqual([
      {
        message_id: 'r1',
        line: LINE,
        from: 'bea@example.ch',
        from_name: 'Bea Muster',
        date: expect.any(String) as unknown as string,
        title: 'Invoice',
        text_preview: 'Hello Andy',
        has_attachments: false,
        is_read: false,
      },
    ]);
  });

  test('filters alone are one Outlook filter, newest first', async () => {
    boot([(req) => (req.url.includes('$filter') ? listed() : undefined)]);
    await call('read', { account: 'o1', from: 'bea@example.ch', since: '2026-09-01', until: '2026-09-20', unreadOnly: true, limit: 500 });
    const url = seen[0]?.url ?? '';
    expect(url).toContain(
      "$filter=receivedDateTime ge 2026-09-01T00:00:00.000Z and receivedDateTime lt 2026-09-20T00:00:00.000Z and from/emailAddress/address eq 'bea@example.ch' and isRead eq false",
    );
    expect(url).toContain('$orderby=receivedDateTime desc');
    expect(url).toContain('$top=50');
    expect((result().messages as unknown[]).length).toBe(2);
  });

  test('a message id returns it in full with its files saved, and marks it read', async () => {
    boot([
      (req) => (req.method === 'GET' && req.url.startsWith(`${GRAPH}/me/messages/r9?`) ? json(message('r9', { hasAttachments: true })) : undefined),
      (req) => (req.url.includes('/r9/attachments?') ? json({ value: [{ id: 'f1', name: 'notes.txt', contentType: 'text/plain', size: 2 }] }) : undefined),
      (req) => (req.url.endsWith('/r9/attachments/f1/$value') ? new Response('hi') : undefined),
      (req) => (req.method === 'PATCH' ? json({}) : undefined),
    ]);
    await call('read', { line: LINE, messageId: 'r9' });
    const m = result().message as Record<string, unknown>;
    expect(m).toMatchObject({ message_id: 'r9', title: 'Invoice', to: [SELF], cc: [], is_read: true, text: 'Hello Andy,\n\nsee attached & thanks' });
    const [file] = m.attachments as Record<string, unknown>[];
    expect(file).toMatchObject({ name: 'notes.txt', mime: 'text/plain', size: 2 });
    expect(readFileSync(String(file?.local_path), 'utf8')).toBe('hi');
    expect(seen.at(-1)).toMatchObject({ method: 'PATCH', url: `${GRAPH}/me/messages/r9`, body: '{"isRead":true}' });
  });

  test('an expired access token is renewed once and the call goes through', async () => {
    let first = true;
    const acct = boot([
      (req) => (req.url.includes('/oauth2/') ? json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }) : undefined),
      (req) => {
        if (!req.url.includes('$filter')) return undefined;
        if (first) {
          first = false;
          return json({ error: { code: 'InvalidAuthenticationToken', message: 'expired' } }, 401);
        }
        return req.auth === 'Bearer at-2' ? json({ value: [] }) : undefined;
      },
    ]);
    await call('read', { account: 'o1' });
    expect(result().messages).toEqual([]);
    expect(acct.state.refreshToken).toBe('rt-2');
  });

  test('accounts report the mailbox and where to open it', async () => {
    boot([]);
    await call('accounts', {});
    expect(result().accounts).toEqual([{ id: 'o1', handle: SELF, url: 'https://outlook.office.com/mail/', email: SELF }]);
  });
});
