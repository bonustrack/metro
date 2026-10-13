import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { existsSync, readdirNames, readRange } from '../agent-user/agent-fs.js';

const HEAD_BYTES = 64 * 1024;
const SKIPPED_RE = /Channel notifications skipped: ([^"\\]+)/;
const REGISTERED = 'Channel notifications registered';
const NAME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.jsonl$/;
const SLACK_MS = 5_000;

export interface ChannelState {
  registered: boolean;
  reason: string | null;
}

let state: ChannelState | null = null;

export const channelState = (): ChannelState | null => state;

export function forgetChannelState(): void {
  state = null;
}

export const mcpLogDir = (home: string): string =>
  join(home, '.cache', 'claude-cli-nodejs', home.replace(/[^a-zA-Z0-9]/g, '-'), 'mcp-logs-metro');

const openedAt = (name: string): number => {
  const m = NAME_RE.exec(name);
  return m === null ? Number.NaN : Date.parse(`${m[1] ?? ''}T${m[2] ?? ''}:${m[3] ?? ''}:${m[4] ?? ''}.${m[5] ?? ''}Z`);
};

export function readChannelState(home: string, since: number): ChannelState | null {
  const dir = mcpLogDir(home);
  if (!existsSync(dir)) return null;
  const newest = readdirNames(dir).filter((name) => openedAt(name) >= since - SLACK_MS).sort().at(-1);
  if (newest === undefined) return null;
  const head = readRange(join(dir, newest), 0, HEAD_BYTES).toString('utf8');
  const skipped = SKIPPED_RE.exec(head);
  if (skipped !== null) return { registered: false, reason: skipped[1]?.trim() ?? null };
  return head.includes(REGISTERED) ? { registered: true, reason: null } : null;
}

export function noteChannelState(home: string, since: number): boolean {
  let found: ChannelState | null;
  try {
    found = readChannelState(home, since);
  } catch (err) {
    log.debug({ err: errMsg(err) }, 'claude-session: could not read the metro MCP log of Claude Code');
    return false;
  }
  if (found === null) return false;
  state = found;
  if (found.registered) log.info('claude-session: Claude Code registered the metro channel');
  else log.error({ reason: found.reason }, 'claude-session: Claude Code skipped the metro channel, so chat messages do not reach the session');
  return true;
}
