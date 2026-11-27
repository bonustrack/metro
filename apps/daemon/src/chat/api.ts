import type { IncomingMessage, ServerResponse } from 'node:http';
import { CHAT_TEXT_MAX } from '@metro-labs/core/chat';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import { APPROVAL_ID_RE } from '@metro-labs/http/approval-rules';
import { apiFailure, apiSession, cors, readJsonBody, sendJson, type ApiSession } from '@metro-labs/http/api-http';
import type { ChatGate } from './tickets.js';
import type { ChatTurns } from './turns.js';
import type { Turn, TurnView } from './turn.js';

const START = '/api/chat/turns';
const TURN = /^\/api\/chat\/turns\/([^/]+)\/(events|stop|answer)$/;
const WAIT_MS = 25_000;
const BODY_MAX = 128 * 1024;

export interface ChatApiDeps {
  gate: ChatGate;
  turns: ChatTurns;
  waitMs?: number;
}

async function caller(req: IncomingMessage): Promise<ApiSession & { userId: string }> {
  const session = await apiSession(req);
  const userId = session?.userId;
  if (session === null || userId === undefined) throw new ApiError('unauthorized', 401);
  return { ...session, userId };
}

const field = (body: unknown, key: string): unknown => (isRecord(body) ? body[key] : undefined);

async function start(req: IncomingMessage, deps: ChatApiDeps): Promise<{ turn: string }> {
  const session = await caller(req);
  const body = await readJsonBody(req, BODY_MAX);
  const text = field(body, 'text');
  if (typeof text !== 'string' || text.trim() === '' || text.length > CHAT_TEXT_MAX) throw new ApiError('text must be the message metro.box kept', 400);
  const ticket = await deps.gate.send(field(body, 'ticket'), session.userId, text);
  const prompt = ticket.group ? `${ticket.name}: ${text}` : text;
  const turn = deps.gate.spend(ticket, () => deps.turns.start({ id: ticket.message, chat: ticket.chat, prompt }));
  return { turn: turn.id };
}

async function turnOf(req: IncomingMessage, deps: ChatApiDeps, id: string): Promise<{ turn: Turn; body: unknown }> {
  const session = await caller(req);
  const body = await readJsonBody(req, BODY_MAX);
  const ticket = await deps.gate.check(field(body, 'ticket'), session.userId);
  const turn = deps.turns.find(id);
  if (turn?.chat !== ticket.chat) throw new ApiError('The agent has no reply in progress for this message.', 404);
  return { turn, body };
}

async function events(req: IncomingMessage, deps: ChatApiDeps, id: string): Promise<TurnView> {
  const { turn, body } = await turnOf(req, deps, id);
  const raw = field(body, 'after');
  const after = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
  await turn.changed(after, deps.waitMs ?? WAIT_MS);
  return turn.view(after);
}

async function stop(req: IncomingMessage, deps: ChatApiDeps, id: string): Promise<{ stopping: boolean }> {
  const { turn } = await turnOf(req, deps, id);
  return { stopping: deps.turns.stop(turn.id) };
}

async function answer(req: IncomingMessage, deps: ChatApiDeps, id: string): Promise<{ answered: boolean }> {
  const { turn, body } = await turnOf(req, deps, id);
  const approval = field(body, 'approval');
  const allow = field(body, 'allow');
  if (typeof approval !== 'string' || !APPROVAL_ID_RE.test(approval) || typeof allow !== 'boolean') throw new ApiError('approval and allow are required', 400);
  return { answered: deps.turns.answer(turn.id, approval, allow) };
}

type Handler = (req: IncomingMessage, deps: ChatApiDeps) => Promise<unknown>;

function handlerOf(path: string): Handler | null {
  if (path === START) return start;
  const [, id = '', action] = TURN.exec(path) ?? [];
  if (action === 'events') return (req, deps) => events(req, deps, id);
  if (action === 'stop') return (req, deps) => stop(req, deps, id);
  return action === 'answer' ? (req, deps) => answer(req, deps, id) : null;
}

export function handleChatRequest(req: IncomingMessage, res: ServerResponse, deps: ChatApiDeps): boolean {
  const handler = handlerOf((req.url ?? '').split('?')[0] ?? '');
  if (handler === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  handler(req, deps)
    .then((result) => {
      sendJson(req, res, 200, result);
    })
    .catch((err: unknown) => {
      apiFailure(req, res, err, 'chat');
    });
  return true;
}
