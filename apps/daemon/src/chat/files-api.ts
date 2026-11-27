import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { INLINE_IMAGE_TYPES } from '@metro-labs/core/chat';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { apiFailure, cors, sendJson } from '@metro-labs/http/api-http';
import { createReadStream } from '../agent-user/agent-fs.js';
import type { ChatApiDeps } from './api.js';
import type { StoredFile } from './files.js';
import { chatCaller } from './tickets.js';

const PREFIX = '/api/chat/files/';
const FILE = /^\/api\/chat\/files\/([A-Za-z0-9_-]{11})\/([A-Za-z0-9_-]{11})$/;
const TICKET_HEADER = 'x-metro-chat-ticket';

const notFound = (): ApiError => new ApiError('No such file.', 404);

const ticketOf = (req: IncomingMessage): string | undefined => {
  const value = req.headers[TICKET_HEADER];
  return typeof value === 'string' ? value : undefined;
};

const fileCors = (req: IncomingMessage): Record<string, string> => ({
  ...cors(req),
  'access-control-allow-headers': 'Authorization, Content-Type, X-Metro-Chat-Ticket',
  'access-control-expose-headers': 'Content-Disposition, Content-Length',
});

function declaredLength(req: IncomingMessage): number | null {
  const raw = req.headers['content-length'];
  const n = Number(raw);
  return raw === undefined || !Number.isInteger(n) || n < 0 ? null : n;
}

async function upload(req: IncomingMessage, deps: ChatApiDeps, message: string, id: string): Promise<{ file: string; size: number }> {
  const session = await chatCaller(req);
  const { ticket, file } = await deps.gate.fileOf(ticketOf(req), session.userId, message, id);
  if (deps.turns.find(message) !== undefined) throw new ApiError('This message was already sent to the agent.', 409);
  const declared = declaredLength(req);
  if (declared !== null && declared !== file.size) throw new ApiError('This file is not the size metro.box said it would be.', 400);
  await deps.files.receive(ticket.chat, message, file, req);
  log.info({ chat: ticket.chat, message, bytes: file.size }, 'chat: a file reached the agent');
  return { file: id, size: file.size };
}

const encoded = (name: string): string => encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function fileHeaders(req: IncomingMessage, file: StoredFile): Record<string, string> {
  const inline = INLINE_IMAGE_TYPES.has(file.type);
  return {
    ...fileCors(req),
    'content-type': inline ? file.type : 'application/octet-stream',
    'content-disposition': inline ? 'inline' : `attachment; filename*=UTF-8''${encoded(file.name)}`,
    'content-length': String(file.size),
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=300',
  };
}

async function serve(req: IncomingMessage, res: ServerResponse, deps: ChatApiDeps, chat: string, id: string): Promise<void> {
  const session = await chatCaller(req);
  const ticket = await deps.gate.check(ticketOf(req), session.userId);
  const file = ticket.chat === chat ? deps.files.find(chat, id) : null;
  if (file === null) throw notFound();
  res.writeHead(200, fileHeaders(req, file));
  await pipeline(createReadStream(file.path), res);
}

function closeIfBodyUnread(req: IncomingMessage, res: ServerResponse): void {
  if (req.readableEnded) return;
  const drop = (): void => {
    req.socket?.destroy();
  };
  if (res.writableFinished) drop();
  else res.once('finish', drop);
}

function failed(req: IncomingMessage, res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    log.warn({ status: res.statusCode }, 'chat: a file could not be sent to the page');
    res.destroy();
    return;
  }
  apiFailure(req, res, err, 'chat files');
  closeIfBodyUnread(req, res);
}

function work(req: IncomingMessage, res: ServerResponse, deps: ChatApiDeps, a: string, b: string): Promise<void> {
  if (req.method === 'PUT') return upload(req, deps, a, b).then((result) => { sendJson(req, res, 200, result); });
  return serve(req, res, deps, a, b);
}

export function handleChatFileRequest(req: IncomingMessage, res: ServerResponse, deps: ChatApiDeps): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (!path.startsWith(PREFIX)) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, fileCors(req)).end();
    return true;
  }
  const [, a, b] = FILE.exec(path) ?? [];
  if (a === undefined || b === undefined) failed(req, res, notFound());
  else if (req.method !== 'PUT' && req.method !== 'GET') failed(req, res, new ApiError('method not allowed', 405));
  else work(req, res, deps, a, b).catch((err: unknown) => { failed(req, res, err); });
  return true;
}
