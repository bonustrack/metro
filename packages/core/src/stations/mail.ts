import { mintId } from '../ids.js';
import { Line } from '../lines.js';
import { TrainError } from '../train-error.js';
import { capText } from './mail-text.js';

export type MailStation = 'outlook' | 'gmail';

type Args = Record<string, unknown>;

export interface MailItem {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  fromName: string;
  to: string[];
  cc: string[];
  date: string | null;
  preview: string;
  text: string;
  hasAttachments: boolean;
  isRead: boolean;
  internetMessageId: string | null;
}

export interface AttachmentMeta {
  kind: string;
  name: string;
  mime: string;
  size?: number;
}

export interface OutgoingFile {
  path: string;
  mime: string;
  name: string;
}

export interface ReadQuery {
  threadId: string | null;
  query: string;
  from: string;
  since: string;
  until: string;
  before: string;
  unreadOnly: boolean;
  limit: number;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
const SEEN_MAX = 500;
const SUBJECT_MAX = 255;
const ADDRESS_RE = /^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/;

export interface MailService {
  station: MailStation;
  company: string;
  product: string;
  api: string;
  apiCode: string;
}

export function refusalOf(s: MailService, status: number, detail: string): TrainError {
  const refuse = (code: string, text: string, retryable = false): TrainError => new TrainError(`${s.station}_${code}`, text, { retryable });
  if (status === 401) return refuse('signed_out', `${s.company} refused this mailbox's sign-in (${detail}); connect ${s.product} again from the page`);
  if (status === 403) return refuse('forbidden', `${s.company} does not let Metro do that on this mailbox (${detail})`);
  if (status === 404) return refuse('not_found', `${s.product} has no such message or conversation (${detail})`);
  if (status === 413) return refuse('too_large', `${s.product} refused the size of that request (${detail})`);
  if (status === 429) return refuse('throttled', `${s.company} asked Metro to slow down (${detail}); try again in a minute`, true);
  return refuse(s.apiCode, `${s.api} answered ${String(status)} (${detail})`, status >= 500);
}

export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const encodeResource = (id: string): string => id.replace(/%/g, '%25').replace(/\//g, '%2F').replace(/\+/g, '%2B');

export const mailLine = (station: MailStation, accountId: string, threadId: string): string =>
  `metro://${station}/${accountId}/${encodeResource(threadId)}`;

const mailUser = (station: MailStation, accountId: string, address: string): string =>
  `metro://${station}/${accountId}/user/${address.toLowerCase()}`;

export function threadOfLine(station: MailStation, line: string): { accountId: string; threadId: string } | null {
  const parsed = Line.parseMail(line, station);
  if (parsed === null) return null;
  try {
    return { accountId: parsed.accountId, threadId: decodeURIComponent(parsed.resource) };
  } catch {
    return null;
  }
}

const isPrivateTo = (m: MailItem, self: string): boolean => m.to.length === 1 && m.to[0] === self && m.cc.length === 0;

export function mailEnvelope(station: MailStation, accountId: string, self: string, m: MailItem, attachments: AttachmentMeta[], verified: boolean): Record<string, unknown> {
  const body = capText(m.text);
  return {
    id: mintId(),
    ts: m.date ?? new Date().toISOString(),
    station,
    line: mailLine(station, accountId, m.threadId),
    line_name: m.subject === '' ? '(no subject)' : m.subject,
    from: mailUser(station, accountId, m.from === '' ? 'unknown' : m.from),
    from_name: m.fromName || m.from,
    from_display_name: m.fromName || undefined,
    message_id: m.id,
    text: m.subject === '' ? body : `Subject: ${m.subject}\n\n${body}`,
    is_private: isPrivateTo(m, self),
    sender_verified: verified,
    payload: {
      from: m.from,
      to: m.to,
      cc: m.cc,
      subject: m.subject,
      internetMessageId: m.internetMessageId,
      ...(attachments.length === 0 ? {} : { attachments }),
    },
  };
}

const heading = (station: MailStation, accountId: string, m: MailItem): Record<string, unknown> => ({
  message_id: m.id,
  line: mailLine(station, accountId, m.threadId),
  from: m.from,
  from_name: m.fromName,
  date: m.date,
  title: m.subject,
});

export const mailSummary = (station: MailStation, accountId: string, m: MailItem): Record<string, unknown> => ({
  ...heading(station, accountId, m),
  text_preview: m.preview,
  has_attachments: m.hasAttachments,
  is_read: m.isRead,
});

export const mailFull = (station: MailStation, accountId: string, m: MailItem): Record<string, unknown> => ({
  ...heading(station, accountId, m),
  has_attachments: m.hasAttachments,
  is_read: m.isRead,
  to: m.to,
  cc: m.cc,
  text: capText(m.text),
});

export const isAddress = (target: string): boolean => target.includes('@');

export const isEmailAddress = (value: string): boolean => ADDRESS_RE.test(value);

export function checkAddress(station: MailStation, to: string): void {
  if (!isEmailAddress(to)) throw new TrainError(`${station}_bad_address`, `not an email address: ${to}`, { retryable: false });
}

export function subjectOf(station: MailStation, subject: string, text: string): string {
  const chosen = subject !== '' ? subject : (text.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  if (chosen === '') throw new TrainError(`${station}_subject_required`, 'a new email needs a subject or some text', { retryable: false });
  return chosen.length > SUBJECT_MAX ? `${chosen.slice(0, SUBJECT_MAX - 3)}...` : chosen;
}

export const filesOf = (raw: unknown): OutgoingFile[] =>
  (Array.isArray(raw) ? raw : [])
    .map((a) => (a ?? {}) as Record<string, unknown>)
    .filter((a) => typeof a.path === 'string' && a.path !== '')
    .map((a) => ({
      path: String(a.path),
      mime: typeof a.mime === 'string' && a.mime !== '' ? a.mime : 'application/octet-stream',
      name: typeof a.name === 'string' && a.name !== '' ? a.name : 'file',
    }));

function isoOf(station: MailStation, raw: string, field: string): string {
  if (raw === '') return '';
  const at = Date.parse(raw);
  if (Number.isNaN(at)) throw new TrainError(`${station}_bad_date`, `${field} must be a date, for example 2026-09-24 or 2026-09-24T10:00:00Z`, { retryable: false });
  return new Date(at).toISOString();
}

export function readQueryOf(station: MailStation, args: Args): ReadQuery {
  const line = str(args.line);
  const thread = line === '' ? null : threadOfLine(station, line);
  if (line !== '' && thread === null) throw new TrainError(`${station}_bad_line`, `not a valid ${station} line: ${line}`, { retryable: false });
  return {
    threadId: thread?.threadId ?? null,
    query: str(args.query),
    from: str(args.from).toLowerCase(),
    since: isoOf(station, str(args.since), 'since'),
    until: isoOf(station, str(args.until), 'until'),
    before: str(args.before),
    unreadOnly: args.unreadOnly === true,
    limit: typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), MAX_LIMIT) : DEFAULT_LIMIT,
  };
}

export const seenOf = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : []);

export function noteSeen(seen: string[], messageId: string): void {
  seen.push(messageId);
  if (seen.length > SEEN_MAX) seen.splice(0, seen.length - SEEN_MAX);
}

export function pollForever(tag: string, once: () => Promise<unknown>, intervalMs: number): void {
  const tick = (): void => {
    once()
      .catch((err: unknown) => {
        process.stderr.write(`${tag} mail check failed: ${err instanceof Error ? err.message : String(err)}\n`);
      })
      .finally(() => {
        setTimeout(tick, intervalMs);
      });
  };
  tick();
}
