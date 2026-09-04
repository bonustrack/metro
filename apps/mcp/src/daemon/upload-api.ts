import { open, rename, rm, type FileHandle } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { guessMime } from '../stations/attachments.js';
import { safeFileName } from '../stations/attach-inline.js';
import {
  allowedAgents,
  authenticate,
  extractToken,
} from '../mcp/request-identity.js';
import { ApiError } from './api-error.js';
import { apiFailure, cors, sendJson } from './api-http.js';
import { log } from './log.js';
import { writeSecure } from './secure-fs.js';
import {
  createUploadSlot,
  liveUploadBytes,
  MAX_LIVE_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  readUpload,
  removeUpload,
  sweepUploads,
  uploadPath,
  uploadSlot,
  uploadTicketAllows,
  UPLOAD_TTL_MS,
  type UploadRecord,
} from './upload-store.js';

const PREFIX = '/api/uploads';
const ITEM_METHODS = ['PUT', 'POST', 'DELETE'];
const DRAIN_MAX = 2 * MAX_UPLOAD_BYTES;
const VAGUE_MIMES = new Set([
  'application/x-www-form-urlencoded',
  'application/octet-stream',
  '',
]);

const mib = (n: number): string => `${Math.round(n / (1024 * 1024))} MiB`;

const uploadLimit = (): string =>
  `${mib(MAX_UPLOAD_BYTES)} (${MAX_UPLOAD_BYTES} bytes)`;

const tooLarge = (): string =>
  `upload exceeds the ${uploadLimit()} per-file limit; ` +
  'send a link in `text` for anything larger';

const noRoom = (): string =>
  `metro is already holding close to ${mib(MAX_LIVE_UPLOAD_BYTES)} of pending uploads, ` +
  `which is the daemon-wide cap; each one expires ${Math.round(UPLOAD_TTL_MS / 60_000)} ` +
  'minutes after it is created, or DELETE one you no longer need';

type Target =
  | { kind: 'collection' }
  | { kind: 'item'; id: string }
  | { kind: 'unknown' }
  | null;

export function target(path: string): Target {
  if (path === PREFIX || path === `${PREFIX}/`) return { kind: 'collection' };
  if (!path.startsWith(`${PREFIX}/`)) return null;
  const rest = path.slice(PREFIX.length + 1).split('/').filter(Boolean);
  const id = rest.length === 1 ? rest[0] : undefined;
  if (id === undefined || uploadPath(id) === null) return { kind: 'unknown' };
  return { kind: 'item', id };
}

const query = (req: IncomingMessage, key: string): string | undefined =>
  new URL(req.url ?? '/', 'http://localhost').searchParams.get(key) ?? undefined;

const identityScope = (req: IncomingMessage): Set<string> =>
  allowedAgents(authenticate(req) ?? undefined);

function ownerFromScope(req: IncomingMessage, allowed: Set<string>): string {
  const requested = query(req, 'agent');
  if (requested !== undefined) {
    if (!allowed.has(requested))
      throw new ApiError(`agent ${requested} is outside your scope`, 403);
    return requested;
  }
  const [only] = [...allowed];
  if (allowed.size === 1 && only !== undefined) return only;
  throw new ApiError(
    `this credential covers ${allowed.size} agents; ` +
      'name the owning agent with ?agent=<id>',
    400,
  );
}

function mimeFor(req: IncomingMessage, name: string): string {
  const explicit = query(req, 'mime');
  if (explicit !== undefined && explicit !== '') return explicit;
  const header = (req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
  return VAGUE_MIMES.has(header.toLowerCase()) ? guessMime(name) : header;
}

function roomForUpload(): number {
  sweepUploads();
  const room = MAX_LIVE_UPLOAD_BYTES - liveUploadBytes();
  if (room <= 0) throw new ApiError(noRoom(), 507);
  return room;
}

const overflowAt = (total: number, room: number): ApiError | undefined => {
  if (total > MAX_UPLOAD_BYTES) return new ApiError(tooLarge(), 413);
  return total > room ? new ApiError(noRoom(), 507) : undefined;
};

function declaredLength(req: IncomingMessage): number | undefined {
  const n = Number(req.headers['content-length']);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function assertRoomForDeclared(req: IncomingMessage, room: number): void {
  const declared = declaredLength(req);
  if (declared === undefined) return;
  if (declared > MAX_UPLOAD_BYTES) throw new ApiError(tooLarge(), 413);
  if (declared > room) throw new ApiError(noRoom(), 507);
}

async function drainInto(
  req: IncomingMessage,
  handle: FileHandle,
  room: number,
): Promise<number> {
  let over: ApiError | undefined;
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      over ??= overflowAt(total, room);
      if (over === undefined) await handle.write(buf);
      else if (total > DRAIN_MAX) break;
    }
  } finally {
    await handle.close();
  }
  if (over !== undefined) throw over;
  if (total === 0) throw new ApiError('upload body is empty', 400);
  return total;
}

async function streamToSlot(req: IncomingMessage, id: string): Promise<number> {
  const part = uploadPath(id, '.part');
  const final = uploadPath(id);
  if (part === null || final === null) throw new ApiError('bad upload id', 400);
  const room = roomForUpload();
  assertRoomForDeclared(req, room);
  const handle = await open(part, 'wx', 0o600).catch(() => {
    throw new ApiError('this upload is already being written', 409);
  });
  const total = await drainInto(req, handle, room).catch(
    async (err: unknown) => {
      await rm(part, { force: true });
      throw err;
    },
  );
  await rename(part, final);
  return total;
}

const payload = (rec: UploadRecord): Record<string, unknown> => ({
  id: rec.id,
  name: rec.name,
  mime: rec.mime,
  bytes: rec.bytes,
  expires_at: new Date(rec.expiresAt).toISOString(),
  attachment: { upload: rec.id },
});

async function fill(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  status: number,
): Promise<void> {
  const bytes = await streamToSlot(req, id);
  const rec = readUpload(id);
  if (rec === undefined) throw new ApiError('upload expired while storing', 410);
  log.info({ upload: id, agent: rec.agentId, bytes }, 'uploads: stored');
  sendJson(req, res, status, payload(rec));
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const allowed = identityScope(req);
  if (allowed.size === 0) throw new ApiError('unauthorized', 401);
  const name = safeFileName(query(req, 'name'));
  const id = createUploadSlot(ownerFromScope(req, allowed), {
    name,
    mime: mimeFor(req, name),
  });
  try {
    await fill(req, res, id, 201);
  } catch (err) {
    removeUpload(id);
    throw err;
  }
}

function authorizeItem(req: IncomingMessage, id: string): string {
  const slot = uploadSlot(id);
  if (slot === undefined) throw new ApiError('no such upload', 404);
  if (uploadTicketAllows(id, slot.agentId, extractToken(req) ?? ''))
    return slot.agentId;
  if (identityScope(req).has(slot.agentId)) return slot.agentId;
  throw new ApiError('no such upload', 404);
}

function relabelSlot(id: string, name: string, mime: string | undefined): void {
  const slot = uploadSlot(id);
  const path = uploadPath(id, '.meta');
  if (slot === undefined || path === null) return;
  writeSecure(
    path,
    JSON.stringify({
      name,
      mime: mime !== undefined && mime !== '' ? mime : guessMime(name),
      createdAt: slot.createdAt,
    }),
  );
}

async function handleFill(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  authorizeItem(req, id);
  if (readUpload(id) !== undefined)
    throw new ApiError('this upload already holds bytes', 409);
  const name = query(req, 'name');
  if (name !== undefined)
    relabelSlot(id, safeFileName(name), query(req, 'mime'));
  await fill(req, res, id, 200);
}

function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): void {
  authorizeItem(req, id);
  removeUpload(id);
  log.info({ upload: id }, 'uploads: deleted');
  sendJson(req, res, 200, { id, deleted: true });
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  tgt: { kind: 'collection' } | { kind: 'item'; id: string },
): Promise<void> {
  if (tgt.kind === 'collection') return handleCreate(req, res);
  if (req.method === 'DELETE') handleDelete(req, res, tgt.id);
  else await handleFill(req, res, tgt.id);
}

function closeIfBodyUnread(req: IncomingMessage, res: ServerResponse): void {
  if (req.readableEnded) return;
  const drop = (): void => {
    req.socket?.destroy();
  };
  if (res.writableFinished) drop();
  else res.once('finish', drop);
}

export function handleUploadRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const tgt = target((req.url ?? '').split('?')[0] ?? '');
  if (tgt === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (tgt.kind === 'unknown') {
    sendJson(req, res, 404, { error: 'no such upload' });
    return true;
  }
  const methods = tgt.kind === 'collection' ? ['POST'] : ITEM_METHODS;
  if (!methods.includes(req.method ?? '')) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  dispatch(req, res, tgt).catch((err: unknown) => {
    apiFailure(req, res, err, 'upload-api');
    closeIfBodyUnread(req, res);
  });
  return true;
}
