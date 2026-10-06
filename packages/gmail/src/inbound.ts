import { log } from '@metro-labs/core/log';
import { mailEnvelope, noteSeen, pollForever } from '@metro-labs/core/stations/mail';
import { emitInbound, reportAttachment } from '@metro-labs/core/stations/train-events';
import { TrainError } from '@metro-labs/core/train-error';
import type { Account } from './accounts.js';
import { gmailJson, HistoryGone, queryOf, USER } from './api.js';
import { saveFile, withBodies } from './attachments.js';
import { headersOf, itemOf, mailFilesOf, metaOf, type GmailMessage } from './message.js';
import { screen } from './trust.js';

const POLL_MS = Number(process.env.METRO_GMAIL_POLL_MS) || 30_000;

interface HistoryPage {
  history?: { messagesAdded?: { message?: { id?: string; labelIds?: string[] } }[] }[];
  nextPageToken?: string;
  historyId?: string;
}

const addedTo = (page: HistoryPage): string[] =>
  (page.history ?? []).flatMap((h) =>
    (h.messagesAdded ?? []).flatMap(({ message }) => {
      const labels = message?.labelIds;
      const inbox = labels === undefined || (labels.includes('INBOX') && !labels.includes('DRAFT'));
      return message?.id !== undefined && inbox ? [message.id] : [];
    }),
  );

async function fetched(acct: Account, messageId: string): Promise<GmailMessage | null> {
  try {
    return await withBodies(acct, await gmailJson<GmailMessage>(acct, `${USER}/messages/${encodeURIComponent(messageId)}?format=full`));
  } catch (err) {
    if (err instanceof TrainError && err.code === 'gmail_not_found') return null;
    throw err;
  }
}

async function deliver(acct: Account, messageId: string): Promise<boolean> {
  const m = await fetched(acct, messageId);
  if (m === null) return false;
  const item = itemOf(m);
  if (item.from === acct.email) return false;
  const verdict = screen(headersOf(m), item.from, acct.cfg.includeAutomated === true);
  if ('skip' in verdict) {
    log.debug({ account: acct.id, reason: verdict.skip }, 'gmail: skipped an automated mail');
    return false;
  }
  const files = mailFilesOf(m);
  const env = mailEnvelope('gmail', acct.id, acct.email, item, files.map(metaOf), verdict.verified);
  acct.check();
  emitInbound(acct.id, env);
  const at = { station: 'gmail', account: acct.id, line: String(env.line), forId: String(env.id) };
  for (const [index, file] of files.entries())
    reportAttachment(saveFile(acct, m.id, file, index), { ...at, index }, { saved: { kind: file.kind, size: file.size }, failed: { kind: file.kind } });
  return true;
}

async function walk(acct: Account, start: string): Promise<{ count: number; latest: string }> {
  let count = 0;
  let latest = start;
  let pageToken: string | undefined;
  do {
    const params: [string, string][] = [['startHistoryId', start], ['historyTypes', 'messageAdded'], ['labelId', 'INBOX'], ...(pageToken === undefined ? [] : [['pageToken', pageToken] as [string, string]])];
    const page = await gmailJson<HistoryPage>(acct, `${USER}/history?${queryOf(params)}`);
    for (const id of addedTo(page)) {
      if (acct.state.seen.includes(id)) continue;
      if (await deliver(acct, id)) count += 1;
      noteSeen(acct.state.seen, id);
    }
    latest = page.historyId ?? latest;
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return { count, latest };
}

export async function syncOnce(acct: Account): Promise<number> {
  const state = acct.state;
  if (state.historyId === null) {
    state.historyId = (await gmailJson<{ historyId?: string }>(acct, `${USER}/profile`)).historyId ?? null;
    acct.save();
    return 0;
  }
  let count = 0;
  try {
    const walked = await walk(acct, state.historyId);
    count = walked.count;
    state.historyId = walked.latest;
  } catch (err) {
    if (!(err instanceof HistoryGone)) throw err;
    state.historyId = null;
  }
  acct.save();
  return count;
}

export function startPolling(acct: Account): void {
  pollForever(`gmail[${acct.id}]`, () => syncOnce(acct), POLL_MS);
}
