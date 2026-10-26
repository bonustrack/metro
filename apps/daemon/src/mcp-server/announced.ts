import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { readJson, writeSecure } from '@metro-labs/core/secure-fs';
import { MCP_APPROVAL_ID_RE } from '@metro-labs/http/mcp-server-protocol';

const KEEP_MS = 24 * 3_600_000;
const MAX = 200;

interface Announced {
  line: string;
  at: number;
}

let file: string | undefined;
let known = new Map<string, Announced>();

function entryOf(raw: unknown): Announced | null {
  if (!isRecord(raw) || typeof raw.line !== 'string' || !raw.line.startsWith('metro://') || typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return null;
  return { line: raw.line, at: raw.at };
}

function parse(raw: unknown): Map<string, Announced> {
  const out = new Map<string, Announced>();
  const entries = isRecord(raw) && raw.version === 1 && isRecord(raw.announced) ? raw.announced : {};
  for (const [id, value] of Object.entries(entries)) {
    const entry = entryOf(value);
    if (MCP_APPROVAL_ID_RE.test(id) && entry !== null) out.set(id, entry);
  }
  return out;
}

function prune(now: number): void {
  for (const [id, entry] of known) if (now - entry.at >= KEEP_MS || entry.at > now) known.delete(id);
  const oldest = [...known].sort(([, a], [, b]) => a.at - b.at);
  for (const [id] of oldest.slice(0, Math.max(0, known.size - MAX))) known.delete(id);
}

function save(): void {
  if (file === undefined) return;
  const announced = Object.fromEntries(known);
  try {
    writeSecure(file, `${JSON.stringify({ version: 1, announced })}\n`);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'mcp-server: the announced approvals could not be saved, so they are kept in memory only');
  }
}

export function setAnnouncedFile(path: string, now = Date.now()): void {
  file = path;
  known = parse(readJson<unknown>(path, null, { warn: 'mcp-server: the announced approvals file is not valid JSON, so it was ignored' }));
  prune(now);
}

export function announcedLine(id: string, now = Date.now()): string | undefined {
  const entry = known.get(id);
  return entry !== undefined && now - entry.at < KEEP_MS && entry.at <= now ? entry.line : undefined;
}

export function noteAnnounced(id: string, line: string, now = Date.now()): void {
  known.set(id, { line, at: now });
  prune(now);
  save();
}

export function forgetAnnounced(): void {
  file = undefined;
  known = new Map();
}
