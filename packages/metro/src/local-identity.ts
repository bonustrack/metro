/** Resolve the local user identity for Claude Code / Codex hosts — used to mint */
/** `metro://claude/<orgId>/<sessionId>` and `metro://codex/<accountId>/<threadId>` URIs */
/** for the local user. Not "stations" — these are the runtimes metro runs inside. */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { STATE_DIR } from './paths.js';

const TTL_MS = 5_000;
let claudeCache: { id: string; at: number } | null = null;

function claudeAccountId(): string {
  if (claudeCache && Date.now() - claudeCache.at < TTL_MS) return claudeCache.id;
  let raw: string;
  try {
    raw = execFileSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`metro: failed to run 'claude auth status --json' — is Claude Code installed and on PATH? (${(e as Error).message})`);
  }
  let parsed: { loggedIn?: boolean; orgId?: string };
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`metro: 'claude auth status --json' returned non-JSON: ${raw.slice(0, 200)}`); }
  if (!parsed.loggedIn || !parsed.orgId) {
    throw new Error('metro: Claude Code is not logged in — run \'claude auth login\'');
  }
  claudeCache = { id: parsed.orgId, at: Date.now() };
  return parsed.orgId;
}

export function claudeUserId(): string {
  return process.env.METRO_USER_ID || claudeAccountId();
}

export function claudeSessionId(): string | null {
  return process.env.METRO_USER_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || null;
}

let codexCache: { id: string; at: number } | null = null;

function codexAuthPath(): string {
  return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
}

function codexAccountId(): string {
  if (codexCache && Date.now() - codexCache.at < TTL_MS) return codexCache.id;
  const path = codexAuthPath();
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) { throw new Error(`metro: failed to read ${path} — is Codex logged in? (${(e as Error).message})`); }
  let parsed: { tokens?: { account_id?: string }; auth_mode?: string };
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`metro: ${path} is not valid JSON`); }
  const id = parsed.tokens?.account_id;
  if (!id) {
    throw new Error(`metro: no Codex account_id in ${path} (auth_mode=${parsed.auth_mode ?? 'unknown'}) — sign in with 'codex login' (ChatGPT mode required)`);
  }
  codexCache = { id, at: Date.now() };
  return id;
}

export function codexUserId(): string {
  return process.env.METRO_USER_ID || codexAccountId();
}

const CODEX_SESSION_FILE = join(STATE_DIR, 'codex-session-id');

export function codexSessionId(): string | null {
  if (process.env.METRO_USER_SESSION_ID) return process.env.METRO_USER_SESSION_ID;
  try { return readFileSync(CODEX_SESSION_FILE, 'utf8').trim() || null; }
  catch { return null; }
}

export function setCodexSessionId(threadId: string | null): void {
  try {
    mkdirSync(dirname(CODEX_SESSION_FILE), { recursive: true });
    writeFileSync(CODEX_SESSION_FILE, threadId ?? '');
  } catch { /* CLI just won't have a session segment */ }
}
