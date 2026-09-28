import { mailFull, mailSummary, MAX_LIMIT, readQueryOf, str, type ReadQuery } from '@metro-labs/core/stations/mail';
import { respond } from '@metro-labs/core/stations/station-runtime';
import { accountOf, type Account } from './accounts.js';
import { listFiles, saveFile } from './attachments.js';
import { itemOf, LIST_FIELDS, MESSAGE_FIELDS, type GraphMessage } from './format.js';
import { graph, graphJson, jsonInit, messagePath, odataQuote, queryOf } from './graph.js';
import { EPOCH } from './outbound.js';

type Args = Record<string, unknown>;

function outlookQuery(args: Args): ReadQuery {
  const q = readQueryOf('outlook', args);
  return { ...q, query: q.query.replace(/"/g, '') };
}

export function filterOf(q: ReadQuery, beforeAt: string): string {
  const parts = [`receivedDateTime ge ${q.since === '' ? EPOCH : q.since}`];
  const until = [q.until, beforeAt].filter((s) => s !== '').sort()[0];
  if (until !== undefined) parts.push(`receivedDateTime lt ${until}`);
  if (q.threadId !== null) parts.push(`conversationId eq ${odataQuote(q.threadId)}`);
  if (q.from !== '') parts.push(`from/emailAddress/address eq ${odataQuote(q.from)}`);
  if (q.unreadOnly) parts.push('isRead eq false');
  return parts.join(' and ');
}

function inWindow(at: number, q: ReadQuery, beforeAt: string): boolean {
  if (q.since !== '' && at < Date.parse(q.since)) return false;
  if (q.until !== '' && at >= Date.parse(q.until)) return false;
  return beforeAt === '' || at < Date.parse(beforeAt);
}

function matches(q: ReadQuery, m: GraphMessage, beforeAt: string): boolean {
  if (q.threadId !== null && m.conversationId !== q.threadId) return false;
  if (q.unreadOnly && m.isRead === true) return false;
  return inWindow(Date.parse(m.receivedDateTime ?? ''), q, beforeAt);
}

async function receivedAt(acct: Account, messageId: string): Promise<string> {
  if (messageId === '') return '';
  const m = await graphJson<GraphMessage>(acct, `${messagePath(messageId)}?$select=receivedDateTime`);
  return m.receivedDateTime ?? '';
}

export function searchParams(q: ReadQuery, beforeAt: string): string {
  if (q.query === '')
    return queryOf({ $filter: filterOf(q, beforeAt), $orderby: 'receivedDateTime desc', $top: String(q.limit), $select: LIST_FIELDS });
  const terms = q.from === '' ? q.query : `from:${q.from} ${q.query}`;
  return queryOf({ $search: `"${terms}"`, $top: String(MAX_LIMIT), $select: LIST_FIELDS });
}

async function list(id: string, acct: Account, q: ReadQuery): Promise<void> {
  const beforeAt = await receivedAt(acct, q.before);
  const body = await graphJson<{ value?: GraphMessage[] }>(acct, `/me/messages?${searchParams(q, beforeAt)}`);
  const found = (body.value ?? []).filter((m) => q.query === '' || matches(q, m, beforeAt)).slice(0, q.limit);
  respond(id, {
    result: {
      account: acct.id,
      mode: q.query === '' ? 'filter' : 'search',
      messages: found.map((m) => mailSummary('outlook', acct.id, itemOf(m))),
    },
  });
}

async function one(id: string, acct: Account, messageId: string): Promise<void> {
  const m = await graphJson<GraphMessage>(acct, `${messagePath(messageId)}?$select=${MESSAGE_FIELDS}`);
  const files = m.hasAttachments === true ? await listFiles(acct, m.id) : [];
  const attachments = [];
  for (const [index, file] of files.entries()) {
    const saved = await saveFile(acct, m.id, file, index);
    attachments.push({ name: file.name, mime: file.mime, kind: file.kind, size: saved.bytes, local_path: saved.path });
  }
  if (m.isRead !== true) await graph(acct, messagePath(m.id), jsonInit('PATCH', { isRead: true }));
  respond(id, { result: { account: acct.id, message: { ...mailFull('outlook', acct.id, itemOf(m)), is_read: true, attachments } } });
}

export async function read(id: string, args: Args): Promise<void> {
  const acct = accountOf(args);
  const messageId = str(args.messageId);
  if (messageId !== '') {
    await one(id, acct, messageId);
    return;
  }
  await list(id, acct, outlookQuery(args));
}
