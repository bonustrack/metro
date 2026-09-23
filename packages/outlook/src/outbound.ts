import { respond } from '@metro-labs/core/stations/station-runtime';
import { TrainError } from '@metro-labs/core/train-error';
import { accountOf, type Account } from './accounts.js';
import { assertSendable, attachFile, filesOf, type OutgoingFile } from './attachments.js';
import { conversationOfLine } from './format.js';
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

async function answer(id: string, args: Args, verb: 'reply' | 'replyAll'): Promise<void> {
  const line = str(args.line);
  const parsed = conversationOfLine(line);
  if (parsed === null) throw new TrainError('outlook_bad_line', `not an outlook line: ${line}`, { retryable: false });
  const acct = accountOf(args);
  const files = filesOf(args.attachments);
  const text = typeof args.text === 'string' ? args.text : '';
  if (text.trim() === '' && files.length === 0)
    throw new TrainError('outlook_text_required', 'give some text or a file to send', { retryable: false });
  await assertSendable(files);
  const replyTo = str(args.replyTo);
  const target = replyTo === '' ? await latestInConversation(acct, parsed.conversationId) : replyTo;
  const comment = escapeHtml(text);
  let labels: string[] = [];
  if (files.length === 0) await graph(acct, `${messagePath(target)}/${verb}`, jsonInit('POST', { comment }));
  else labels = await withFiles(acct, target, verb, comment, files);
  respond(id, { result: { account: acct.id, repliedTo: target, ...(labels.length > 0 ? { attachments: labels } : {}) } });
}

export const reply = (id: string, args: Args): Promise<void> => answer(id, args, 'reply');

export const send = (id: string, args: Args): Promise<void> => answer(id, args, str(args.replyTo) === '' ? 'replyAll' : 'reply');
