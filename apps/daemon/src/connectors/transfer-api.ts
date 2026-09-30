import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, type KeyObject } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';
import { parseId } from '@metro-labs/core/ids';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { apiSession, cors, readJsonBody, requireAdmin, sendJson } from '@metro-labs/http/api-http';
import { openTransfer, sealTransfer, transferKeys } from './transfer-crypto.js';
import type { LocalConnectorRow } from './store.js';
import type { ConnectorCopyResult } from './transfer-store.js';

const PREFIX = '/api/connectors/transfer';
const MAX_BODY = 4 * 1024 * 1024 + 4096;
const TTL = 5 * 60_000;

export interface ConnectorTransferDeps {
  read: () => LocalConnectorRow[];
  copy: (value: unknown) => ConnectorCopyResult[];
  now?: () => number;
}

interface Ticket {
  privateKey: KeyObject;
  organization: string;
  expiresAt: number;
}

function selectedIds(raw: unknown): string[] | null {
  if (raw === null) return null;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 500) throw new ApiError('choose connectors to copy', 400);
  return [...new Set(raw.map((id: unknown) => {
    if (typeof id !== 'string' || parseId(id) === null) throw new ApiError('choose connectors to copy', 400);
    return id;
  }))];
}

export class ConnectorTransfers {
  private readonly tickets = new Map<string, Ticket>();

  constructor(private readonly deps: ConnectorTransferDeps) {}

  private prepare(organization: string): unknown {
    const now = (this.deps.now ?? Date.now)();
    for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= now) this.tickets.delete(id);
    if (this.tickets.size >= 64) throw new ApiError('too many pending connector copies, try again later', 429);
    const { publicKey, privateKey } = transferKeys();
    const ticket = randomUUID();
    this.tickets.set(ticket, { privateKey, organization, expiresAt: now + TTL });
    return { ticket, publicKey };
  }

  private export(body: Record<string, unknown>): unknown {
    if (typeof body.publicKey !== 'string') throw new ApiError('invalid transfer key', 400);
    const ids = selectedIds(body.ids);
    const all = this.deps.read();
    const rows = ids === null ? all : all.filter((row) => ids.includes(row.id));
    const expected = ids?.length ?? rows.length;
    if (rows.length !== expected) throw new ApiError('a selected connector no longer exists', 404);
    if (rows.length > 500) throw new ApiError('copy at most 500 connectors at once', 413);
    try {
      return sealTransfer({ version: 1, connectors: rows }, body.publicKey);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError('invalid transfer key', 400);
    }
  }

  private receive(body: Record<string, unknown>, organization: string): unknown {
    const id = typeof body.ticket === 'string' ? body.ticket : '';
    const ticket = this.tickets.get(id);
    if (ticket?.organization !== organization || ticket.expiresAt <= (this.deps.now ?? Date.now)()) {
      this.tickets.delete(id);
      throw new ApiError('this connector copy has expired, start again', 410);
    }
    let value: unknown;
    try {
      value = openTransfer(body.envelope, ticket.privateKey);
    } catch {
      throw new ApiError('invalid encrypted connector copy', 400);
    }
    const results = this.deps.copy(value);
    this.tickets.delete(id);
    return { results };
  }

  private async answer(req: IncomingMessage, path: string): Promise<unknown> {
    const session = await apiSession(req);
    if (session === null) throw new ApiError('unauthorized', 401);
    requireAdmin(session);
    const body = await readJsonBody(req, MAX_BODY);
    if (!isRecord(body) || body.confirmed !== true) throw new ApiError('confirm copying saved logins and settings', 400);
    if (path === `${PREFIX}/prepare`) return this.prepare(session.subject);
    if (path === `${PREFIX}/export`) return this.export(body);
    return this.receive(body, session.subject);
  }

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (![`${PREFIX}/prepare`, `${PREFIX}/export`, `${PREFIX}/receive`].includes(path)) return false;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors(req)).end();
      return true;
    }
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'method not allowed' });
      return true;
    }
    this.answer(req, path).then((body) => {
      sendJson(req, res, 200, body);
    }).catch((err: unknown) => {
      if (!(err instanceof ApiError)) log.warn('connector-transfer: request failed');
      sendJson(req, res, err instanceof ApiError ? err.status : 500, { error: err instanceof ApiError ? err.message : 'connector copy failed' });
    });
    return true;
  }
}
