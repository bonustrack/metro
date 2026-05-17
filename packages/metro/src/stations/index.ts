/** Line URI scheme + envelope types + minimal station listing. Used by everything in the daemon. */

import { tryClaudeAccountId } from './claude.js';
import { tryCodexAccountId } from './codex.js';
import { readHistory } from '../history.js';
import { listUsers } from '../registry.js';
import { listEndpoints, webhookPort } from '../webhooks.js';
import { loadTunnelConfig } from '../tunnel.js';
import type { LineKind } from '../broker.js';

export type Line = string & { readonly __line: unique symbol };
export const asLine = (s: string): Line => s as Line;

/** Universal envelope — what the daemon emits on stdout / appends to history.jsonl. */
export interface Envelope<TPayload = unknown> {
  /** Universal metro ID (`msg_…`). Minted by the dispatcher. */
  id: string;
  /** ISO timestamp from the transport. */
  ts: string;
  station: string;
  /** The conversation URI (channel / chat / topic). */
  line: Line;
  lineName?: string;
  /** Universal participant URI of the sender: `metro://<station>/user/<id>`. */
  from: Line;
  /** Display name (`@alice`, `bonustrack_`) — optional. */
  fromName?: string;
  /** Universal participant URI of the recipient — the user consuming metro. */
  to?: Line;
  /** Platform-side message id. Distinct from universal `id`. */
  messageId?: string;
  /** Universal display projection. Includes `[image]` / `[file: …]` inline. */
  text?: string;
  emoji?: string;
  /** True when the conversation has a single human counterpart (DM / private chat). */
  isPrivate?: boolean;
  /** Station-native raw object. Shape varies per `station`. */
  payload: TPayload;
}

/** Inbound chat message — alias kept for backward source compat. New code uses `Envelope`. */
export type InboundMessage<TPayload = unknown> = Envelope<TPayload>;

/** Reaction event — same shape as Envelope minus `text`, plus required `emoji`. */
export interface InboundReaction {
  id: string;
  ts: string;
  station: string;
  line: Line;
  lineName?: string;
  from: Line;
  fromName?: string;
  messageId: string;
  emoji: string;
  isPrivate?: boolean;
}

const PREFIX = 'metro://';
const build = (station: string, ...seg: (string | number)[]): Line =>
  asLine(`${PREFIX}${station}/${seg.map(String).join('/')}`);

/** Shared parser for `metro://{claude,codex}/<userId>/<sessionId>`. Skips the `/user/…` participant URI. */
function parseLocalSession(line: Line | string, station: 'claude' | 'codex'): { userId: string; sessionId: string } | null {
  const p = Line.parse(line);
  if (p?.station !== station || p.path[0] === 'user' || p.path.length < 2) return null;
  return { userId: p.path[0], sessionId: p.path[1] };
}

/** URI helpers. Const that doubles as the `Line` type's value-side namespace. */
export const Line = {
  discord: (channelId: string): Line => build('discord', channelId),
  telegram: (chatId: number | string, topicId?: number): Line =>
    topicId !== undefined ? build('telegram', chatId, topicId) : build('telegram', chatId),
  claude: (orgId: string, sessionId: string): Line => build('claude', orgId, sessionId),
  codex: (accountId: string, threadId: string): Line => build('codex', accountId, threadId),
  webhook: (endpointId: string): Line => build('webhook', endpointId),
  user: (station: string, id: string | number): Line => build(station, 'user', id),

  parse(line: Line | string): { station: string; path: string[] } | null {
    if (!line.startsWith(PREFIX)) return null;
    const rest = line.slice(PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const path = rest.slice(slash + 1).split('/').filter(Boolean);
    return path.length ? { station: rest.slice(0, slash), path } : null;
  },
  station: (line: Line | string): string | null => Line.parse(line)?.station ?? null,
  parseDiscord(line: Line): string | null {
    const p = Line.parse(line);
    return p?.station === 'discord' && p.path.length === 1 ? p.path[0] : null;
  },
  parseTelegram(line: Line): { chatId: number; topicId?: number } | null {
    const p = Line.parse(line);
    if (p?.station !== 'telegram') return null;
    const chatId = Number(p.path[0]);
    if (!Number.isFinite(chatId)) return null;
    if (p.path.length === 1) return { chatId };
    const topicId = Number(p.path[1]);
    return Number.isFinite(topicId) ? { chatId, topicId } : null;
  },
  parseClaude: (line: Line | string) => parseLocalSession(line, 'claude'),
  parseCodex: (line: Line | string) => parseLocalSession(line, 'codex'),
  parseWebhook(line: Line | string): string | null {
    const p = Line.parse(line);
    return p?.station === 'webhook' && p.path.length === 1 ? p.path[0] : null;
  },
  isLocal: (line: Line | string): boolean => {
    const s = Line.station(line);
    return s === 'claude' || s === 'codex';
  },
};

/** Classify a chat line as DM / group / unknown — feeds the auto-claim group-skip rule. */
/** Telegram: chat-id sign is authoritative (id < 0 ⇒ group). Discord: peek `payload.guildId` on */
/** the most-recent inbound (null ⇒ DM, set ⇒ group, none seen ⇒ unknown). Claude/Codex ⇒ dm. */
export function classifyLine(line: Line): LineKind {
  const station = Line.station(line);
  if (station === 'telegram') {
    const parsed = Line.parseTelegram(line);
    if (!parsed) return 'unknown';
    return parsed.chatId < 0 ? 'group' : 'dm';
  }
  if (station === 'claude' || station === 'codex') return 'dm';
  if (station === 'webhook') return 'group';
  if (station === 'discord') {
    /** Look at the most recent inbound on this line; the dispatcher stored the raw message in `payload`. */
    const recent = readHistory({ line, kind: 'inbound', limit: 1 })[0];
    if (!recent) return 'unknown';
    const payload = recent.payload as { guildId?: string | null } | undefined;
    if (!payload || !('guildId' in payload)) {
      /** Older entries may not have a guildId — fall back to the `to` field: DMs route to a user URI. */
      if (recent.to && recent.to !== recent.line) return 'dm';
      return 'unknown';
    }
    return payload.guildId == null ? 'dm' : 'group';
  }
  return 'unknown';
}

export type StationRow = {
  name: string;
  configured: boolean | null;
  detail: string;
};

function seenSummary(station: 'claude' | 'codex'): string {
  const users = listUsers(station);
  if (!users.length) return '';
  const sessions = users.reduce((n, u) => n + u.sessions.length, 0);
  return ` · seen ${users.length} user${users.length === 1 ? '' : 's'}, ${sessions} session${sessions === 1 ? '' : 's'}`;
}

function claudeStationDetail(): string {
  const seen = seenSummary('claude');
  if (!process.env.CLAUDECODE) return `launch metro from inside a Claude Code session${seen}`;
  const orgId = tryClaudeAccountId();
  return `${orgId ? `account: ${orgId}` : 'logged out — run `claude auth login`'}${seen}`;
}

function codexStationDetail(): string {
  const rc = process.env.METRO_CODEX_RC;
  const accountId = tryCodexAccountId();
  const seen = seenSummary('codex');
  const parts = [
    accountId ? `account: ${accountId}` : (rc ? '(no Codex account — run `codex login`)' : null),
    rc ? `push → ${rc}` : (!accountId ? 'set METRO_CODEX_RC=ws://… to push' : null),
  ].filter(Boolean);
  return `${parts.join(' · ')}${seen}`;
}

function webhookStationDetail(): string {
  const eps = listEndpoints();
  const t = loadTunnelConfig();
  const base = t ? `https://${t.hostname}` : `http://127.0.0.1:${webhookPort()}`;
  if (!eps.length) return `no endpoints (run \`metro webhook add <label>\`)${t ? ` · tunnel → ${t.hostname}` : ''}`;
  return `${eps.length} endpoint${eps.length === 1 ? '' : 's'} · base ${base}${t ? '' : ' (no tunnel — run `metro tunnel setup`)'}`;
}

export const listStations = (): StationRow[] => [
  { name: 'discord', configured: !!process.env.DISCORD_BOT_TOKEN, detail: 'DISCORD_BOT_TOKEN' },
  { name: 'telegram', configured: !!process.env.TELEGRAM_BOT_TOKEN, detail: 'TELEGRAM_BOT_TOKEN' },
  { name: 'claude', configured: !!process.env.CLAUDECODE, detail: claudeStationDetail() },
  {
    name: 'codex',
    configured: !!(process.env.METRO_CODEX_RC || process.env.CODEX_HOME),
    detail: codexStationDetail(),
  },
  {
    name: 'webhook',
    configured: listEndpoints().length > 0,
    detail: webhookStationDetail(),
  },
];
