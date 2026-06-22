import { execFileSync } from 'node:child_process';
import { errMsg } from './log.js';
import { Line } from './lines.js';

const TTL_MS = 5_000;
type Cache = { id: string; at: number } | null;

function memo(loader: () => string): () => string {
  let cache: Cache = null;
  return () => {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.id;
    const id = loader();
    cache = { id, at: Date.now() };
    return id;
  };
}

const claudeAccountId = memo(() => {
  let raw: string;
  try {
    raw = execFileSync('claude', ['auth', 'status', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error(
      `metro: failed to run 'claude auth status --json' — is Claude Code installed? (${errMsg(e)})`,
    );
  }
  let p: { loggedIn?: boolean; orgId?: string };
  try {
    p = JSON.parse(raw) as { loggedIn?: boolean; orgId?: string };
  } catch {
    throw new Error(
      `metro: 'claude auth status --json' returned non-JSON: ${raw.slice(0, 200)}`,
    );
  }
  if (!p.loggedIn || !p.orgId)
    throw new Error(
      "metro: Claude Code is not logged in — run 'claude auth login'",
    );
  return p.orgId;
});

export const claudeUserId = (): string =>
  process.env.METRO_USER_ID ?? claudeAccountId();

export const claudeSessionId = (): string | null =>
  process.env.METRO_USER_SESSION_ID ??
  process.env.CLAUDE_CODE_SESSION_ID ??
  null;

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
