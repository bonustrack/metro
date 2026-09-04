import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from './log.js';
import { verifyMessage } from 'viem';
import { apiFailure, cors, readJsonBody, sendJson } from './api-http.js';
import { normalizeAddress } from '../db/users.js';
import { parseId } from '../db/ids.js';
import { ENVELOPE_MAX, type VaultBundle, type VaultEntry } from '../db/vault.js';

const PREFIX = '/api/vault';
const BODY_MAX = ENVELOPE_MAX + 64 * 1024;
const SKEW_MS = 5 * 60_000;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

export const vaultChallenge = (method: string, path: string, at: number): string =>
  `metro-vault\n${method} ${path}\n${String(at)}`;

interface VaultProof {
  address: string;
  at: number;
  signature: `0x${string}`;
}

function parseVaultHeader(header: string): VaultProof | null {
  const [scheme, rawAddress, rawAt, signature] = header.trim().split(/\s+/);
  if (scheme !== 'Vault' || rawAddress === undefined || rawAt === undefined || signature === undefined) return null;
  const address = normalizeAddress(rawAddress);
  const at = Number(rawAt);
  if (address === null || !Number.isFinite(at) || !SIGNATURE_RE.test(signature)) return null;
  return { address, at, signature: signature as `0x${string}` };
}

export async function vaultIdentity(req: IncomingMessage, now = Date.now()): Promise<string | null> {
  const proof = parseVaultHeader(req.headers.authorization ?? '');
  if (proof === null || Math.abs(now - proof.at) > SKEW_MS) return null;
  const path = (req.url ?? '').split('?')[0] ?? '';
  const message = vaultChallenge(req.method ?? '', path, proof.at);
  const ok = await verifyMessage({ address: proof.address as `0x${string}`, message, signature: proof.signature }).catch(() => false);
  return ok ? proof.address : null;
}

export interface VaultApiDeps {
  list: (subject: string) => Promise<VaultEntry[]>;
  put: (subject: string, id: string, body: unknown) => Promise<VaultEntry>;
  get: (subject: string, id: string) => Promise<VaultBundle>;
  remove: (subject: string, id: string) => Promise<{ id: string; name: string }>;
}

type Target = { kind: 'index' } | { kind: 'bundle'; id: string } | { kind: 'unknown' } | null;

function target(path: string): Target {
  if (path === PREFIX || path === `${PREFIX}/`) return { kind: 'index' };
  if (!path.startsWith(`${PREFIX}/`)) return null;
  const segments = path.slice(PREFIX.length + 1).split('/').filter(Boolean);
  const id = parseId(segments[0] ?? '');
  return id === null || segments.length !== 1 ? { kind: 'unknown' } : { kind: 'bundle', id };
}

const ALLOWED: Record<'index' | 'bundle', string[]> = { index: ['GET'], bundle: ['GET', 'PUT', 'DELETE'] };

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: VaultApiDeps,
  tgt: { kind: 'index' } | { kind: 'bundle'; id: string },
): Promise<void> {
  try {
    const owner = await vaultIdentity(req);
    if (owner === null) {
      sendJson(req, res, 401, { error: 'unauthorized' });
      return;
    }
    if (tgt.kind === 'index') {
      sendJson(req, res, 200, { entries: await deps.list(owner) });
      return;
    }
    if (req.method === 'GET') sendJson(req, res, 200, await deps.get(owner, tgt.id));
    else if (req.method === 'DELETE') sendJson(req, res, 200, await deps.remove(owner, tgt.id));
    else {
      const saved = await deps.put(owner, tgt.id, await readJsonBody(req, BODY_MAX));
      log.info({ id: saved.id, name: saved.name }, 'vault-api: bundle stored');
      sendJson(req, res, 200, saved);
    }
  } catch (err) {
    apiFailure(req, res, err, 'vault-api');
  }
}

export function handleVaultApiRequest(req: IncomingMessage, res: ServerResponse, deps: VaultApiDeps): boolean {
  const tgt = target((req.url ?? '').split('?')[0] ?? '');
  if (tgt === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (tgt.kind === 'unknown') {
    sendJson(req, res, 404, { error: 'no such bundle' });
    return true;
  }
  if (!ALLOWED[tgt.kind].includes(req.method ?? '')) {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  route(req, res, deps, tgt).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'vault-api: unhandled error');
    if (!res.headersSent) sendJson(req, res, 500, { error: 'vault api failed' });
  });
  return true;
}
