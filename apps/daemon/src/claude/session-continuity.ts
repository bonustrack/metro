import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';
import { readJson, writeJson } from '@metro-labs/core/secure-fs';
import { agentsDir } from '../agents/files.js';
import { existsSync, readFileSync, realpathSync } from '../agent-user/agent-fs.js';
import { claudeDir } from './files.js';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sessionId = (value: unknown): string | null => typeof value === 'string' && SESSION_ID_RE.test(value) ? value : null;

function sdkSavedSession(home: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(home, '.metro', 'agent-session.json'), 'utf8'));
    return isRecord(raw) ? raw : null;
  } catch (err) {
    return isRecord(err) && err.code === 'ENOENT' ? {} : null;
  }
}

export function sdkPending(home: string): number | null {
  const state = sdkSavedSession(home);
  if (state === null) return null;
  if (state.sessionId !== undefined && state.sessionId !== null && sessionId(state.sessionId) === null) return null;
  if (state.unanswered === undefined) return 0;
  return Array.isArray(state.unanswered) ? state.unanswered.length : null;
}

function projectFolder(home: string, dir: string): string {
  let cwd = home;
  try {
    cwd = realpathSync(home);
  } catch {
    cwd = home;
  }
  return join(dir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

export function continueArgs(home: string, dir = claudeDir(), agents = agentsDir()): string[] {
  const path = join(agents, 'claude-session.json');
  const raw = readJson<unknown>(path, null);
  const state = isRecord(raw) ? raw : {};
  const project = projectFolder(home, dir);
  const pinned = sessionId(state.cliSessionId);
  const id = pinned ?? randomUUID();
  if (pinned === null) writeJson(path, { ...state, cliSessionId: id });
  return [existsSync(join(project, `${id}.jsonl`)) ? '--resume' : '--session-id', id];
}
