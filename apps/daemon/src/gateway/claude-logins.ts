import { homedir } from 'node:os';
import { join } from 'node:path';
import { ID_RE, newId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { readFileSync } from '../agent-user/agent-fs.js';
import { removeHome } from '../agent-user/home-fs.js';
import { claudeHome } from '../agent-user/user.js';
import { claudeAccountIn, type ClaudeAccount, type LoginTarget } from '../claude/login.js';
import { readClaudeUsage } from '../claude/usage-probe.js';
import { currentOf, reach, refreshed, type TokenSource, type TokenState } from './subscription.js';
import { forgetReported } from './usage.js';
import { addConnection, connectionOf, readModelConfig, setClaudeLogin, writeModelConfig, type ModelConfig } from './model-config.js';

const CREDENTIALS = '.credentials.json';
const RENEW_MARGIN_MS = 60_000;
const NEW = 'new';
const MISSING = 'this Claude login is no longer on the box: sign in again on the Model page';

export interface ClaudeLoginDeps {
  root?: string;
  probe?: (env: Record<string, string>) => Promise<unknown>;
  account?: (env: Record<string, string>) => ClaudeAccount;
  read?: () => ModelConfig;
  write?: (cfg: ModelConfig) => void;
}

interface ClaudeTokens {
  accessToken: string;
  expiresAt: number | null;
  savedAt: string;
}

const state: TokenState<ClaudeTokens> = new Map();
const seen = new Map<string, ClaudeTokens>();

const claudeLoginsRoot = (): string => join(claudeHome() ?? homedir(), '.metro', 'claude-logins');

const rootOf = (deps: ClaudeLoginDeps): string => deps.root ?? claudeLoginsRoot();

function claudeLoginEnv(login: string, deps: ClaudeLoginDeps = {}): Record<string, string> {
  if (!ID_RE.test(login)) throw new Error('not a Claude login id');
  return { CLAUDE_CONFIG_DIR: join(rootOf(deps), login) };
}

export const probeClaudeLogin = (login: string, deps: ClaudeLoginDeps = {}): Promise<unknown> =>
  (deps.probe ?? ((env) => readClaudeUsage({ env })))(claudeLoginEnv(login, deps));

const stale = (tokens: ClaudeTokens, margin = RENEW_MARGIN_MS): boolean => tokens.expiresAt !== null && tokens.expiresAt - margin <= Date.now();

function onDisk(login: string, deps: ClaudeLoginDeps): ClaudeTokens | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(claudeLoginEnv(login, deps).CLAUDE_CONFIG_DIR ?? '', CREDENTIALS), 'utf8'));
  } catch {
    return null;
  }
  const oauth = isRecord(raw) && isRecord(raw.claudeAiOauth) ? raw.claudeAiOauth : {};
  const accessToken = typeof oauth.accessToken === 'string' ? oauth.accessToken : '';
  const expiresAt = typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null;
  return accessToken === '' ? null : { accessToken, expiresAt, savedAt: new Date(expiresAt ?? 0).toISOString() };
}

function remembered(login: string, tokens: ClaudeTokens | null): ClaudeTokens | null {
  if (tokens === null) seen.delete(login);
  else seen.set(login, tokens);
  return tokens;
}

function known(login: string, deps: ClaudeLoginDeps): ClaudeTokens | null {
  const kept = seen.get(login);
  if (kept !== undefined && !stale(kept)) return kept;
  const read = onDisk(login, deps);
  return read === null && kept !== undefined ? kept : remembered(login, read);
}

function sourceFor(login: string, deps: ClaudeLoginDeps): TokenSource<ClaudeTokens> {
  return {
    label: 'Claude',
    stale: (tokens) => stale(tokens),
    refresh: async () => {
      try {
        await probeClaudeLogin(login, deps);
      } catch (err) {
        log.warn({ err: errMsg(err) }, 'claude-logins: Claude Code stumbled while renewing a login, so its folder is read as it is');
      }
      const fresh = onDisk(login, deps);
      if (fresh === null || stale(fresh, 0)) throw new Error('Claude Code could not renew this login');
      return fresh;
    },
    save: (id, tokens) => {
      remembered(id, tokens);
    },
  };
}

function again(login: string, failed: ClaudeTokens, deps: ClaudeLoginDeps, source: TokenSource<ClaudeTokens>): Promise<ClaudeTokens> {
  const disk = onDisk(login, deps);
  if (disk !== null && disk.accessToken !== failed.accessToken && !stale(disk)) return Promise.resolve(remembered(login, disk) ?? disk);
  return refreshed(state, login, failed, source);
}

export function withClaudeLogin(login: string, deps: ClaudeLoginDeps, send: (token: string) => Promise<Response>): Promise<Response> {
  const source = sourceFor(login, deps);
  return reach(
    () => currentOf(state, login, known(login, deps), source, MISSING),
    (failed) => again(login, failed, deps, source),
    (tokens) => send(tokens.accessToken),
  );
}

function dropClaudeLogin(login: string, deps: ClaudeLoginDeps): void {
  seen.delete(login);
  state.delete(login);
  try {
    removeHome(claudeLoginEnv(login, deps).CLAUDE_CONFIG_DIR ?? '', true);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'claude-logins: could not remove a Claude login that is no longer used');
  }
}

export function dropUnusedClaudeLogins(before: ModelConfig, after: ModelConfig, deps: ClaudeLoginDeps = {}): void {
  const kept = new Set(after.connections.flatMap((c) => (c.claude === null ? [] : [c.claude.id])));
  for (const c of before.connections) if (c.claude !== null && !kept.has(c.claude.id)) dropClaudeLogin(c.claude.id, deps);
}

function keep(login: string, connection: string | null, account: ClaudeAccount, deps: ClaudeLoginDeps): string | null {
  const before = (deps.read ?? readModelConfig)();
  const cfg = connection === null ? addConnection(before, { provider: 'anthropic' }) : before;
  const id = connection ?? cfg.connections.at(-1)?.id ?? '';
  if (connectionOf(cfg, id)?.provider !== 'anthropic') return 'that connection was removed during the sign-in';
  const next = setClaudeLogin(cfg, id, { id: login, email: account.account, plan: account.plan, savedAt: new Date().toISOString() });
  (deps.write ?? writeModelConfig)(next);
  dropUnusedClaudeLogins(before, next, deps);
  forgetReported(id);
  log.info({ connection: id, plan: account.plan, added: connection === null }, 'claude-logins: the Claude login was kept for its own connection');
  return null;
}

function settle(ok: boolean, login: string, connection: string | null, deps: ClaudeLoginDeps): Promise<string | null> {
  if (!ok) {
    dropClaudeLogin(login, deps);
    return Promise.resolve(null);
  }
  let problem: string | null;
  try {
    const account = (deps.account ?? claudeAccountIn)(claudeLoginEnv(login, deps));
    problem = account.signedIn ? keep(login, connection, account, deps) : 'the sign-in finished but Claude Code holds no login; try again';
  } catch (err) {
    problem = errMsg(err);
  }
  if (problem !== null) dropClaudeLogin(login, deps);
  return Promise.resolve(problem);
}

export function claudeLoginTarget(asked: string, deps: ClaudeLoginDeps = {}): LoginTarget {
  const connection = asked === NEW ? null : asked;
  if (connection !== null && connectionOf((deps.read ?? readModelConfig)(), connection)?.provider !== 'anthropic')
    throw new ApiError('no such Anthropic connection', 404);
  const login = newId();
  return { key: asked, env: claudeLoginEnv(login, deps), settle: (ok) => settle(ok, login, connection, deps) };
}

export function forgetClaudeTokens(): void {
  seen.clear();
  state.clear();
}
