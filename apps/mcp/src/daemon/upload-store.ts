import { randomBytes } from 'node:crypto';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSecureDir, readJson, writeSecure } from './secure-fs.js';
import { grantAllowsPath, issueGrant } from './attach-grant.js';
import { ownerOf, recordOwner } from './attach-owner.js';
import { errMsg, log } from './log.js';

export const UPLOAD_TTL_MS = 30 * 60 * 1000;
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_LIVE_UPLOAD_BYTES = 512 * 1024 * 1024;
export const UPLOAD_ID_RE = /^up_[A-Za-z0-9_-]{22}$/;

const SUFFIXES = ['', '.part', '.meta', '.owner', '.grant'] as const;
const SWEEP_MS = 60_000;

export const uploadDir = (): string =>
  process.env.METRO_UPLOAD_DIR ?? join(tmpdir(), 'metro-uploads');

export const newUploadId = (): string =>
  `up_${randomBytes(16).toString('base64url')}`;

export function uploadPath(id: string, suffix = ''): string | null {
  return UPLOAD_ID_RE.test(id) ? `${uploadDir()}/${id}${suffix}` : null;
}

interface UploadMeta {
  name: string;
  mime: string;
  createdAt: number;
}

export interface UploadRecord extends UploadMeta {
  id: string;
  agentId: number;
  bytes: number;
  path: string;
  expiresAt: number;
}

const sizeOf = (path: string): number | undefined => {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
};

function readMeta(id: string): UploadMeta | undefined {
  const path = uploadPath(id, '.meta');
  if (path === null) return undefined;
  const meta = readJson<UploadMeta | null>(path, null);
  if (meta === null || typeof meta.createdAt !== 'number') return undefined;
  return meta;
}

export interface UploadSlot extends UploadMeta {
  id: string;
  agentId: number;
  expiresAt: number;
}

export function uploadSlot(id: string): UploadSlot | undefined {
  const base = uploadPath(id);
  if (base === null) return undefined;
  const meta = readMeta(id);
  const agentId = ownerOf(base);
  if (meta === undefined || agentId === undefined) return undefined;
  const expiresAt = meta.createdAt + UPLOAD_TTL_MS;
  return expiresAt <= Date.now() ? undefined : { ...meta, id, agentId, expiresAt };
}

export function readUpload(id: string): UploadRecord | undefined {
  const slot = uploadSlot(id);
  const path = uploadPath(id);
  if (slot === undefined || path === null) return undefined;
  const bytes = sizeOf(path);
  return bytes === undefined ? undefined : { ...slot, bytes, path };
}

export function createUploadSlot(
  agentId: number,
  meta: { name: string; mime: string },
): string {
  ensureSecureDir(uploadDir());
  const id = newUploadId();
  const base = `${uploadDir()}/${id}`;
  writeSecure(
    `${base}.meta`,
    JSON.stringify({ ...meta, createdAt: Date.now() }),
  );
  recordOwner(base, agentId);
  return id;
}

export const issueUploadTicket = (
  id: string,
  agentId: number,
): string | undefined => {
  const base = uploadPath(id);
  return base === null ? undefined : issueGrant(base, agentId, 'ut');
};

export const uploadTicketAllows = (
  id: string,
  owner: number,
  presented: string,
): boolean => {
  const base = uploadPath(id);
  return base === null ? false : grantAllowsPath(base, owner, presented);
};

export function removeUpload(id: string): void {
  const base = uploadPath(id);
  if (base === null) return;
  for (const suffix of SUFFIXES)
    rmSync(`${base}${suffix}`, { force: true, recursive: false });
}

const idsInDir = (): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(uploadDir());
  } catch {
    return [];
  }
  const ids = new Set<string>();
  for (const entry of entries) {
    const id = entry.split('.')[0] ?? '';
    if (UPLOAD_ID_RE.test(id)) ids.add(id);
  }
  return [...ids];
};

export function liveUploadBytes(): number {
  let total = 0;
  for (const id of idsInDir())
    for (const suffix of ['', '.part'])
      total += sizeOf(`${uploadDir()}/${id}${suffix}`) ?? 0;
  return total;
}

function ageOf(id: string, now: number): number {
  const created = readMeta(id)?.createdAt;
  if (created !== undefined) return now - created;
  let newest = 0;
  for (const suffix of SUFFIXES) {
    let mtime: number;
    try {
      mtime = statSync(`${uploadDir()}/${id}${suffix}`).mtimeMs;
    } catch {
      continue;
    }
    newest = Math.max(newest, mtime);
  }
  return newest === 0 ? 0 : now - newest;
}

export function sweepUploads(now = Date.now()): number {
  let removed = 0;
  for (const id of idsInDir()) {
    if (ageOf(id, now) <= UPLOAD_TTL_MS) continue;
    removeUpload(id);
    removed += 1;
  }
  return removed;
}

export function startUploadReaper(): void {
  const run = (): void => {
    try {
      const removed = sweepUploads();
      if (removed > 0) log.info({ removed }, 'uploads: reaped expired uploads');
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'uploads: sweep failed');
    }
  };
  run();
  setInterval(run, SWEEP_MS).unref?.();
}
