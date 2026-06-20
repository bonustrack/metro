/** Self-identity URIs (claude/daemon) + the append-only user registry. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, log } from './log.js';
import { STATE_DIR } from './paths.js';
import { Line } from './lines.js';
import { claudeUserId, claudeSessionId } from './local-identity.js';

/** The current user's **participant** URI for `from`/`to`. Precedence: METRO_FROM > runtime env > generic. */
export function userSelf(): Line {
  const explicit = process.env.METRO_FROM;
  if (explicit) return explicit as Line;
  if (process.env.CLAUDECODE) return Line.user('claude', claudeUserId());
  return 'metro://user' as Line;
}

// Self URI for trains (`METRO_SELF_URI`). On the shared multi-account daemon a
// per-CLI identity leaks one account's `from` onto another, so propagate only an
// EXPLICIT self; else hand trains neutral `metro://user` to stamp `from` per account.
export function daemonSelf(): Line {
  const explicit = process.env.METRO_FROM || process.env.METRO_SELF_URI;
  return (explicit ?? 'metro://user') as Line;
}

/** The current user's **line** URI `<user-id>/<session>`. Null until the session is known. */
export function selfLine(): Line | null {
  if (process.env.CLAUDECODE) {
    const s = claudeSessionId();
    return s ? Line.claude(claudeUserId(), s) : null;
  }
  return null;
}

/* ──────────── user-registry: append-only (station, userId, sessions[]) tuples ──────────── */

const REGISTRY_FILE = join(STATE_DIR, 'user-registry.json');

type UserInstance = { userId: string; sessions: string[]; lastSeen: string };
type Registry = Record<string, UserInstance[]>;

function readRegistry(): Registry {
  if (!existsSync(REGISTRY_FILE)) return {};
  try { return JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as Registry; }
  catch (err) { log.warn({ err: errMsg(err) }, 'user-registry: malformed, resetting'); return {}; }
}

function record(station: 'claude', userId: string, sessionId: string | null): void {
  const reg = readRegistry();
  const rows = (reg[station] ??= []);
  let row = rows.find(r => r.userId === userId);
  if (!row) { row = { userId, sessions: [], lastSeen: '' }; rows.push(row); }
  if (sessionId && !row.sessions.includes(sessionId)) row.sessions.push(sessionId);
  row.lastSeen = new Date().toISOString();
  try { writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2)); }
  catch (err) { log.warn({ err: errMsg(err) }, 'user-registry: write failed'); }
}

/** Scan a line URI for `(station, userId, sessionId)` and record it. No-op on non-user or participant URIs. */
export function noteUserFromLine(line: string): void {
  if (Line.station(line) !== 'claude') return;
  const p = Line.parseClaude(line);
  if (p) record('claude', p.userId, p.sessionId);
}
