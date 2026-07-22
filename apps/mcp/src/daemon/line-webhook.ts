import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  parseLineEvents,
  readAccountsFile,
  verifyLineSignature,
} from '@metro-labs/line/webhook';
import { errMsg, log } from './log.js';
import type { MetroEvent } from './events.js';

const LINE_BODY_MAX = 1024 * 1024;
const ACCOUNT_RE = /^\/line\/webhook(?:\/([A-Za-z0-9_-]+))?$/;

export function isLineWebhookPath(req: IncomingMessage): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  return path === '/line/webhook' || path.startsWith('/line/webhook/');
}

function accountIdFromUrl(url: string): string | undefined {
  const path = url.split('?')[0] ?? '';
  const m = ACCOUNT_RE.exec(path);
  if (!m) return undefined;
  return m[1] ?? 'default';
}

function findAccount(
  accountId: string,
): ReturnType<typeof readAccountsFile>[number] | undefined {
  const all = readAccountsFile();
  const exact = all.find((a) => a.id === accountId);
  if (exact) return exact;
  if (accountId === 'default' && all.length === 1) return all[0];
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > LINE_BODY_MAX) throw new Error('line webhook body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

type Emit = (entry: MetroEvent) => void;

export async function handleLineWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  emit: Emit,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(req.method === 'GET' ? 200 : 405).end();
    return;
  }
  const accountId = accountIdFromUrl(req.url ?? '');
  const account = accountId ? findAccount(accountId) : undefined;
  if (!account) {
    log.warn({ account: accountId }, 'line webhook: unknown account — rejecting');
    res.writeHead(404).end();
    return;
  }
  const raw = await readBody(req);
  const sig = req.headers['x-line-signature'];
  const header = Array.isArray(sig) ? sig[0] : sig;
  if (!verifyLineSignature(account.channelSecret, raw, header)) {
    log.warn({ account: accountId }, 'line webhook: signature mismatch — rejecting');
    res.writeHead(401).end();
    return;
  }
  try {
    const body = JSON.parse(raw.toString('utf8')) as Parameters<
      typeof parseLineEvents
    >[1];
    for (const entry of parseLineEvents(account.id, body)) emit(entry);
  } catch (err) {
    log.warn({ account: accountId, err: errMsg(err) }, 'line webhook: bad body');
  }
  res.writeHead(200).end('ok');
}
