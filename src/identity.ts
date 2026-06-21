import { join } from 'node:path';
import { errMsg, log } from './log.js';
import { readJson, writeJson } from './secure-fs.js';
import { STATE_DIR } from './paths.js';
import { Line } from './lines.js';
import { claudeUserId, claudeSessionId } from './local-identity.js';

export function userSelf(): Line {
  const explicit = process.env.METRO_FROM;
  if (explicit) return explicit as Line;
  if (process.env.CLAUDECODE) return Line.user('claude', claudeUserId());
  return 'metro://user' as Line;
}

export function daemonSelf(): Line {
  const explicit = process.env.METRO_FROM ?? process.env.METRO_SELF_URI;
  return (explicit ?? 'metro://user') as Line;
}

export function selfLine(): Line | null {
  if (process.env.CLAUDECODE) {
    const s = claudeSessionId();
    return s ? Line.claude(claudeUserId(), s) : null;
  }
  return null;
}

const REGISTRY_FILE = join(STATE_DIR, 'user-registry.json');

interface UserInstance {
  userId: string;
  sessions: string[];
  lastSeen: string;
}
type Registry = Record<string, UserInstance[]>;

function readRegistry(): Registry {
  return readJson<Registry>(
    REGISTRY_FILE,
    {},
    { warn: 'user-registry: malformed, resetting' },
  );
}

function record(
  station: 'claude',
  userId: string,
  sessionId: string | null,
): void {
  const reg = readRegistry();
  const rows = (reg[station] ??= []);
  let row = rows.find((r) => r.userId === userId);
  if (!row) {
    row = { userId, sessions: [], lastSeen: '' };
    rows.push(row);
  }
  if (sessionId && !row.sessions.includes(sessionId))
    row.sessions.push(sessionId);
  row.lastSeen = new Date().toISOString();
  try {
    writeJson(REGISTRY_FILE, reg);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'user-registry: write failed');
  }
}

export function noteUserFromLine(line: string): void {
  if (Line.station(line) !== 'claude') return;
  const p = Line.parseClaude(line);
  if (p) record('claude', p.userId, p.sessionId);
}
