import type { IncomingMessage, ServerResponse } from 'node:http';
import { chatReplyOf, type ChatReply } from '@metro-labs/core/chat';
import { newId, parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, readBodyBytes, sendJson } from '@metro-labs/http/api-http';
import { AgentKeyMissing, refuseBrowser, type AgentAuth } from '@metro-labs/connectors/agent-auth';
import type { AgentKeyRow, AgentKeyStore } from '@metro-labs/connectors/db/agent-keys';
import type { AgentNonceStore } from '@metro-labs/connectors/db/agent-nonces';
import { appendMessage, chatOf, messageOf, replaceReply, replyOf } from '../db/chats.js';
import { sealBody } from './model.js';
import { keysOf, type ChatsDeps } from './read.js';

const PATH = '/api/agents/chats/reply';
const BODY_MAX = 640 * 1024;

export interface AgentChatsDeps extends ChatsDeps {
  identities: Pick<AgentKeyStore, 'find'>;
  nonces: AgentNonceStore;
  auth: AgentAuth;
}

async function signed(req: IncomingMessage, deps: AgentChatsDeps): Promise<{ identity: AgentKeyRow; body: unknown }> {
  refuseBrowser(req);
  const bytes = await readBodyBytes(req, BODY_MAX);
  const proof = deps.auth.proofOf(req);
  const identity = await deps.identities.find(proof.keyId);
  if (identity === null) throw new AgentKeyMissing();
  deps.auth.accept(req, bytes, proof, identity.signingKey, identity.owner);
  await deps.nonces.consume(proof, identity.owner);
  try {
    return { identity, body: JSON.parse(bytes.toString('utf8')) as unknown };
  } catch {
    throw new ApiError('the body must be JSON', 400);
  }
}

function replyInput(body: unknown): { reply: ChatReply; chatId: string; messageId: string } {
  const input = isRecord(body) ? body : {};
  const reply = chatReplyOf(input.reply);
  const chatId = parseId(input.chat);
  const messageId = parseId(input.message);
  if (reply === null || chatId === null || messageId === null) throw new ApiError('chat, message and reply are required', 400);
  return { reply, chatId, messageId };
}

async function saveReply(deps: AgentChatsDeps, identity: AgentKeyRow, body: unknown): Promise<{ id: string }> {
  const { reply, chatId, messageId } = replyInput(body);
  const keys = keysOf(deps);
  const db = deps.db();
  const found = await chatOf(db, identity.owner, chatId);
  const chat = found?.agent === identity.agent ? found : null;
  const asked = chat === null ? null : await messageOf(db, chat.id, messageId);
  if (chat === null || asked?.role !== 'user') throw new ApiError('no such chat message for this agent', 404);
  const now = deps.now();
  const kept = await replyOf(db, chat.id, asked.id);
  const id = kept?.id ?? newId();
  const sealed = sealBody(keys, chat.owner, chat.id, id, reply);
  if (kept === null) await appendMessage(db, { id, chat: chat.id, role: 'assistant', author: null, replyTo: asked.id, body: sealed, at: now });
  else await replaceReply(db, chat.id, id, sealed, now);
  log.info({ chat: chat.id, agent: identity.agent, state: reply.state, parts: reply.parts.length }, 'chats: an agent reply was kept');
  return { id };
}

export function handleAgentChatsRequest(req: IncomingMessage, res: ServerResponse, deps: AgentChatsDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path !== PATH) return false;
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  signed(req, deps)
    .then(({ identity, body }) => saveReply(deps, identity, body))
    .then((result) => {
      sendJson(req, res, 200, result);
    })
    .catch((err: unknown) => {
      if (err instanceof AgentKeyMissing) sendJson(req, res, err.status, { error: err.message, code: 'agent_key_missing' });
      else apiFailure(req, res, err, 'agent-chats');
    });
  return true;
}
