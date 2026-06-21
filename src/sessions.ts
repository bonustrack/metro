import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errMsg, log } from './log.js';
import { asLine, type Line } from './lines.js';
import { STATIONS, type Station } from './messaging.js';
import { claudeSessionId } from './local-identity.js';

export type SessionStation = Station;
export const SESSION_STATIONS: readonly SessionStation[] = STATIONS;

export interface SessionBinding {
  xmtp?: string;
  discord?: string;
  telegram?: string;
  default?: string;
}

export type Sessions = Record<string, SessionBinding>;

export function sessionsFile(): string {
  return (
    process.env.METRO_SESSIONS_FILE ??
    join(homedir(), '.metro', 'sessions.json')
  );
}

export function sessionOwner(sessionId: string): Line {
  return asLine(`metro://session/${sessionId}`);
}

export function sessionsPresent(): boolean {
  return existsSync(sessionsFile());
}

let warnedPerms = false;
function checkPerms(path: string): void {
  if (warnedPerms) return;
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      warnedPerms = true;
      log.warn(
        { path, mode: mode.toString(8) },
        'sessions.json should be mode 0600',
      );
    }
  } catch {
  }
}

export function loadSessions(): Sessions {
  const file = sessionsFile();
  if (!existsSync(file)) return {};
  checkPerms(file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    log.warn(
      { err: errMsg(err), path: file },
      'sessions.json: malformed, ignoring',
    );
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    log.warn({ path: file }, 'sessions.json: not an object, ignoring');
    return {};
  }
  const out: Sessions = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const b = v as Record<string, unknown>;
    const binding: SessionBinding = {};
    for (const k of [...SESSION_STATIONS, 'default'] as const) {
      if (typeof b[k] === 'string' && b[k]) binding[k] = b[k];
    }
    out[id] = binding;
  }
  return out;
}

export function accountForSession(
  sessionId: string,
  station: SessionStation,
): string | null {
  const binding = loadSessions()[sessionId];
  if (!binding) return null;
  return binding[station] ?? binding.default ?? null;
}

export function activeSessionId(): string | null {
  if (process.env.METRO_SESSION) return process.env.METRO_SESSION;
  if (process.env.CLAUDECODE) return claudeSessionId();
  return null;
}

export function listSessions(): {
  id: string;
  owner: Line;
  binding: SessionBinding;
}[] {
  return Object.entries(loadSessions()).map(([id, binding]) => ({
    id,
    owner: sessionOwner(id),
    binding,
  }));
}
