import { checkAddress, filesOf, isAddress, isEmailAddress, mailLine, str, subjectOf, threadOfLine, type OutgoingFile } from '@metro-labs/core/stations/mail';
import { respond } from '@metro-labs/core/stations/station-runtime';
import { TrainError } from '@metro-labs/core/train-error';
import { accountOf, type Account } from './accounts.js';
import { gmailJson, queryOf, USER } from './api.js';
import { assertSendable } from './attachments.js';
import { headerOf, peopleOf, personOf, type GmailMessage } from './message.js';
import { boundaryOf, buildMime } from './mime.js';

type Args = Record<string, unknown>;

interface Sent {
  id?: string;
  threadId?: string;
}

const REPLY_HEADERS = ['From', 'To', 'Cc', 'Reply-To', 'Subject', 'Message-ID', 'References'];

const metadata = (): [string, string][] => [['format', 'metadata'], ...REPLY_HEADERS.map((h): [string, string] => ['metadataHeaders', h])];

async function sendMime(acct: Account, mime: string, threadId: string | null): Promise<Sent> {
  const boundary = boundaryOf();
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(threadId === null ? {} : { threadId }),
    `--${boundary}`,
    'Content-Type: message/rfc822',
    '',
    mime,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return gmailJson<Sent>(acct, `/upload${USER}/messages/send?uploadType=multipart`, {
    method: 'POST',
    headers: { 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  });
}

async function latestIn(acct: Account, threadId: string): Promise<GmailMessage> {
  const thread = await gmailJson<{ messages?: GmailMessage[] }>(acct, `${USER}/threads/${encodeURIComponent(threadId)}?${queryOf(metadata())}`);
  const latest = (thread.messages ?? []).filter((m) => !(m.labelIds ?? []).includes('DRAFT')).at(-1);
  if (latest === undefined) throw new TrainError('gmail_empty_conversation', 'Gmail has no message in this thread to answer', { retryable: false });
  return latest;
}

const addresses = (m: GmailMessage, name: string): string[] => peopleOf(headerOf(m, name)).map((p) => p.address);

export function recipientsOf(m: GmailMessage, self: string, all: boolean): { to: string[]; cc: string[] } {
  const others = (list: string[]): string[] => list.filter((a) => a !== self && isEmailAddress(a));
  const from = personOf(headerOf(m, 'From')).address;
  const replyTo = others(addresses(m, 'Reply-To'));
  const sender = from === self ? others(addresses(m, 'To')) : replyTo.length > 0 ? replyTo : others([from]);
  const to = [...new Set(all ? [...sender, ...others(addresses(m, 'To'))] : sender)];
  const cc = all ? others(addresses(m, 'Cc')).filter((a) => !to.includes(a)) : [];
  if (to.length === 0) throw new TrainError('gmail_no_recipient', 'this mail names nobody to answer', { retryable: false });
  return { to, cc };
}

export const replySubject = (subject: string): string => (/^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`.trim());

interface Outgoing {
  target: string;
  acct: Account;
  files: OutgoingFile[];
  text: string;
  replyTo: string;
}

async function outgoing(args: Args): Promise<Outgoing> {
  const line = str(args.line);
  const parsed = threadOfLine('gmail', line);
  if (parsed === null) throw new TrainError('gmail_bad_line', `not a valid gmail line: ${line}`, { retryable: false });
  const acct = accountOf(args);
  const files = filesOf(args.attachments);
  const text = typeof args.text === 'string' ? args.text : '';
  if (text.trim() === '' && files.length === 0) throw new TrainError('gmail_text_required', 'give some text or a file to send', { retryable: false });
  await assertSendable(files);
  return { target: parsed.threadId, acct, files, text, replyTo: str(args.replyTo) };
}

async function compose(id: string, out: Outgoing, args: Args): Promise<void> {
  const to = out.target.toLowerCase();
  checkAddress('gmail', to);
  const subject = subjectOf('gmail', str(args.subject), out.text);
  const { mime, labels } = await buildMime({ from: out.acct.email, to: [to], cc: [], subject, text: out.text, inReplyTo: '', references: '', files: out.files });
  const sent = await sendMime(out.acct, mime, null);
  const line = sent.threadId === undefined ? undefined : mailLine('gmail', out.acct.id, sent.threadId);
  respond(id, { result: { account: out.acct.id, messageId: sent.id, ...(line === undefined ? {} : { line }), ...(labels.length > 0 ? { attachments: labels } : {}) } });
}

async function answer(id: string, args: Args, all: boolean): Promise<void> {
  const out = await outgoing(args);
  if (isAddress(out.target)) {
    if (!all || out.replyTo !== '')
      throw new TrainError('gmail_reply_needs_thread', "reply on the thread's own line; an address line starts a new email", { retryable: false });
    await compose(id, out, args);
    return;
  }
  const m =
    out.replyTo === ''
      ? await latestIn(out.acct, out.target)
      : await gmailJson<GmailMessage>(out.acct, `${USER}/messages/${encodeURIComponent(out.replyTo)}?${queryOf(metadata())}`);
  const { to, cc } = recipientsOf(m, out.acct.email, all);
  const messageId = headerOf(m, 'Message-ID');
  const { mime, labels } = await buildMime({
    from: out.acct.email,
    to,
    cc,
    subject: replySubject(headerOf(m, 'Subject')),
    text: out.text,
    inReplyTo: messageId,
    references: `${headerOf(m, 'References')} ${messageId}`.trim(),
    files: out.files,
  });
  const sent = await sendMime(out.acct, mime, m.threadId ?? out.target);
  respond(id, { result: { account: out.acct.id, repliedTo: m.id, messageId: sent.id, ...(labels.length > 0 ? { attachments: labels } : {}) } });
}

export const reply = (id: string, args: Args): Promise<void> => answer(id, args, false);

export const send = (id: string, args: Args): Promise<void> => answer(id, args, str(args.replyTo) === '');
