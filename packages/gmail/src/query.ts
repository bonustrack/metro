import { mailFull, mailSummary, MAX_LIMIT, readQueryOf, str, type MailItem, type ReadQuery } from '@metro-labs/core/stations/mail';
import { respond } from '@metro-labs/core/stations/station-runtime';
import { accountOf, type Account } from './accounts.js';
import { gmailJson, queryOf, USER } from './api.js';
import { saveFile, withBodies } from './attachments.js';
import { itemOf, LIST_HEADERS, mailFilesOf, type GmailMessage } from './message.js';

type Args = Record<string, unknown>;

const BATCH = 10;

const listing = (): [string, string][] => [['format', 'metadata'], ...LIST_HEADERS.map((h): [string, string] => ['metadataHeaders', h])];

const messagePath = (messageId: string, params: [string, string][]): string => `${USER}/messages/${encodeURIComponent(messageId)}?${queryOf(params)}`;

const seconds = (iso: string): string => String(Math.floor(Date.parse(iso) / 1000));

const untilOf = (q: ReadQuery, beforeAt: string): string | undefined => [q.until, beforeAt].filter((s) => s !== '').sort()[0];

export function searchOf(q: ReadQuery, beforeAt: string): string {
  const until = untilOf(q, beforeAt);
  return [
    q.query,
    q.from === '' ? '' : `from:${q.from}`,
    q.since === '' ? '' : `after:${seconds(q.since)}`,
    until === undefined ? '' : `before:${seconds(until)}`,
    q.unreadOnly ? 'is:unread' : '',
  ]
    .filter((s) => s !== '')
    .join(' ');
}

function matches(q: ReadQuery, m: MailItem, beforeAt: string): boolean {
  if (q.from !== '' && m.from !== q.from) return false;
  if (q.unreadOnly && m.isRead) return false;
  const at = Date.parse(m.date ?? '');
  if (q.since !== '' && at < Date.parse(q.since)) return false;
  const until = untilOf(q, beforeAt);
  return until === undefined || at < Date.parse(until);
}

async function receivedAt(acct: Account, messageId: string): Promise<string> {
  if (messageId === '') return '';
  const m = await gmailJson<GmailMessage>(acct, messagePath(messageId, [['format', 'minimal']]));
  return itemOf(m).date ?? '';
}

async function inThread(acct: Account, q: ReadQuery, threadId: string, beforeAt: string): Promise<MailItem[]> {
  const thread = await gmailJson<{ messages?: GmailMessage[] }>(acct, `${USER}/threads/${encodeURIComponent(threadId)}?${queryOf(listing())}`);
  return (thread.messages ?? [])
    .map(itemOf)
    .filter((m) => matches(q, m, beforeAt))
    .reverse();
}

async function searched(acct: Account, q: ReadQuery, beforeAt: string): Promise<MailItem[]> {
  const search = searchOf(q, beforeAt);
  const params: [string, string][] = [...(search === '' ? [] : [['q', search] as [string, string]]), ['maxResults', String(q.threadId === null ? q.limit : MAX_LIMIT)]];
  const found = await gmailJson<{ messages?: { id: string; threadId?: string }[] }>(acct, `${USER}/messages?${queryOf(params)}`);
  const ids = (found.messages ?? []).filter((m) => q.threadId === null || m.threadId === q.threadId).slice(0, q.limit);
  const items: MailItem[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH).map((m) => gmailJson<GmailMessage>(acct, messagePath(m.id, listing())));
    items.push(...(await Promise.all(batch)).map(itemOf));
  }
  return items;
}

async function list(id: string, acct: Account, q: ReadQuery): Promise<void> {
  const beforeAt = await receivedAt(acct, q.before);
  const found = q.threadId !== null && q.query === '' ? await inThread(acct, q, q.threadId, beforeAt) : await searched(acct, q, beforeAt);
  acct.check();
  respond(id, {
    result: {
      account: acct.id,
      mode: q.query === '' ? 'filter' : 'search',
      messages: found.slice(0, q.limit).map((m) => mailSummary('gmail', acct.id, m)),
    },
  });
}

async function one(id: string, acct: Account, messageId: string): Promise<void> {
  const m = await withBodies(acct, await gmailJson<GmailMessage>(acct, messagePath(messageId, [['format', 'full']])));
  const attachments = [];
  for (const [index, file] of mailFilesOf(m).entries()) {
    const saved = await saveFile(acct, m.id, file, index);
    attachments.push({ name: file.name, mime: file.mime, kind: file.kind, size: saved.bytes, local_path: saved.path });
  }
  acct.check();
  respond(id, { result: { account: acct.id, message: { ...mailFull('gmail', acct.id, itemOf(m)), attachments } } });
}

export async function read(id: string, args: Args): Promise<void> {
  const acct = accountOf(args);
  const messageId = str(args.messageId);
  if (messageId !== '') {
    await one(id, acct, messageId);
    return;
  }
  await list(id, acct, readQueryOf('gmail', args));
}
