/** Resolve the local user identity for the Claude Code host — used to mint */
/** `metro://claude/<orgId>/<sessionId>` URIs. */

import { execFileSync } from 'node:child_process';

const TTL_MS = 5_000;
type Cache = { id: string; at: number } | null;

/** Memoize an account-id resolver for TTL_MS to avoid hammering `claude auth` / re-reading auth.json. */
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
  try { raw = execFileSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { throw new Error(`metro: failed to run 'claude auth status --json' — is Claude Code installed? (${(e as Error).message})`); }
  let p: { loggedIn?: boolean; orgId?: string };
  try { p = JSON.parse(raw) as { loggedIn?: boolean; orgId?: string }; } catch { throw new Error(`metro: 'claude auth status --json' returned non-JSON: ${raw.slice(0, 200)}`); }
  if (!p.loggedIn || !p.orgId) throw new Error('metro: Claude Code is not logged in — run \'claude auth login\'');
  return p.orgId;
});

export const claudeUserId = (): string => process.env.METRO_USER_ID ?? claudeAccountId();

export const claudeSessionId = (): string | null =>
  process.env.METRO_USER_SESSION_ID ?? process.env.CLAUDE_CODE_SESSION_ID ?? null;
