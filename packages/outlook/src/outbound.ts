import { respond } from '@metro-labs/core/stations/station-runtime';
import { TrainError } from '@metro-labs/core/train-error';
import { accountOf, type Account } from './accounts.js';
import { assertSendable, attachFile, filesOf, type OutgoingFile } from './attachments.js';
import { conversationOfLine, lineOf } from './format.js';
import { graph, graphJson, jsonInit, messagePath, odataQuote, queryOf } from './graph.js';
import { escapeHtml } from './html.js';

type Args = Record<string, unknown>;

export const EPOCH = '1900-01-01T00:00:00Z';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export async function latestInConversation(acct: Account, conversationId: string): Promise<string> {
  const filter = `receivedDateTime ge ${EPOCH} and conversationId eq ${odataQuote(conversationId)}`;
  const params = queryOf({ $filter: filter, $orderby: 'receivedDateTime desc', $top: '1', $select: 'id' });
  const body = await graphJson<{ value?: { id: string }[] }>(acct, `/me/messages?${params}`);
  const id = body.value?.[0]?.id;
  if (id === undefined)
    throw new TrainError('outlook_empty_conversation', 'Outlook has no message in this conversation to answer', { retryable: false });
  return id;
}

async function discard(acct: Account, draftId: string): Promise<void> {
  await graph(acct, messagePath(draftId), { method: 'DELETE' }).catch((err: unknown) => {
    process.stderr.write(`outlook[${acct.id}] could not remove an unsent draft: ${err instanceof Error ? err.message : String(err)}\n`);
  });
}

async function withFiles(acct: Account, target: string, verb: 'reply' | 'replyAll', comment: string, files: OutgoingFile[]): Promise<string[]> {
  const draft = await graphJson<{ id?: string }>(acct, `${messagePath(target)}/${verb === 'reply' ? 'createReply' : 'createReplyAll'}`, jsonInit('POST', { comment }));
  const draftId = draft.id;
  if (draftId === undefined) throw new TrainError('outlook_graph_error', 'Outlook did not open a reply draft', { retryable: true });
  const labels: string[] = [];
  try {
    for (const file of files) labels.push(await attachFile(acct, draftId, file));
    await graph(acct, `${messagePath(draftId)}/send`, { method: 'POST' });
  } catch (err) {
    await discard(acct, draftId);
    throw err;
  }
  return labels;
}

const ADDRESS_RE = /^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/;
const SUBJECT_MAX = 255;

export const isAddress = (target: string): boolean => target.includes('@');

export function subjectOf(subject: string, text: string): string {
  const chosen = subject !== '' ? subject : (text.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  if (chosen === '') throw new TrainError('outlook_subject_required', 'a new email needs a subject or some text', { retryable: false });
  return chosen.length > SUBJECT_MAX ? `${chosen.slice(0, SUBJECT_MAX - 3)}...` : chosen;
}

async function compose(id: string, acct: Account, to: string, args: Args, text: string, files: OutgoingFile[]): Promise<void> {
  if (!ADDRESS_RE.test(to)) throw new TrainError('outlook_bad_address', `not an email address: ${to}`, { retryable: false });
  const draft = await graphJson<{ id?: string; conversationId?: string }>(acct, '/me/messages', jsonInit('POST', {
    subject: subjectOf(str(args.subject), text),
    body: { contentType: 'Text', content: text },
    toRecipients: [{ emailAddress: { address: to } }],
  }));
  if (draft.id === undefined) throw new TrainError('outlook_graph_error', 'Outlook did not open a draft', { retryable: true });
  const labels: string[] = [];
  try {
    for (const file of files) labels.push(await attachFile(acct, draft.id, file));
    await graph(acct, `${messagePath(draft.id)}/send`, { method: 'POST' });
  } catch (err) {
    await discard(acct, draft.id);
    throw err;
  }
  const line = draft.conversationId === undefined ? undefined : lineOf(acct.id, draft.conversationId);
  respond(id, { result: { account: acct.id, messageId: draft.id, ...(line === undefined ? {} : { line }), ...(labels.length > 0 ? { attachments: labels } : {}) } });
}

interface Outgoing {
  target: string;
  acct: Account;
  files: OutgoingFile[];
  text: string;
  replyTo: string;
}

async function outgoing(args: Args): Promise<Outgoing> {
  const line = str(args.line);
  const parsed = conversationOfLine(line);
  if (parsed === null) throw new TrainError('outlook_bad_line', `not an outlook line: ${line}`, { retryable: false });
  const acct = accountOf(args);
  const files = filesOf(args.attachments);
  const text = typeof args.text === 'string' ? args.text : '';
  if (text.trim() === '' && files.length === 0)
    throw new TrainError('outlook_text_required', 'give some text or a file to send', { retryable: false });
  await assertSendable(files);
  return { target: parsed.conversationId, acct, files, text, replyTo: str(args.replyTo) };
}

async function answer(id: string, args: Args, verb: 'reply' | 'replyAll'): Promise<void> {
  const { target: conversation, acct, files, text, replyTo } = await outgoing(args);
  if (isAddress(conversation)) {
    if (verb === 'reply' || replyTo !== '')
      throw new TrainError('outlook_reply_needs_thread', 'reply on the thread\'s own line; an address line starts a new email', { retryable: false });
    await compose(id, acct, conversation.toLowerCase(), args, text, files);
    return;
  }
  const target = replyTo === '' ? await latestInConversation(acct, conversation) : replyTo;
  const comment = escapeHtml(text);
  let labels: string[] = [];
  if (files.length === 0) await graph(acct, `${messagePath(target)}/${verb}`, jsonInit('POST', { comment }));
  else labels = await withFiles(acct, target, verb, comment, files);
  respond(id, { result: { account: acct.id, repliedTo: target, ...(labels.length > 0 ? { attachments: labels } : {}) } });
}

export const reply = (id: string, args: Args): Promise<void> => answer(id, args, 'reply');

export const send = (id: string, args: Args): Promise<void> => answer(id, args, str(args.replyTo) === '' ? 'replyAll' : 'reply');
