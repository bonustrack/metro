// Per-machine cache of `scope_key → codex thread id`. Lets orchestrator
// restarts rejoin the same codex conversation in the same Discord thread
// instead of starting from scratch. JSON file at $STATE_DIR/scopes.json.
//
// Scope keys are platform-prefixed so the same store handles Discord and
// Telegram without collisions:
//   discord:<thread_channel_id>
//   telegram:<chat_id>:<topic_id>

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, log } from '../log.js';
import { STATE_DIR } from '../paths.js';

type Entry = { codexThreadId: string; createdAt: string };
type Cache = Record<string, Entry>;

const cacheFile = join(STATE_DIR, 'scopes.json');

function read(): Cache {
  if (!existsSync(cacheFile)) return {};
  try {
    return JSON.parse(readFileSync(cacheFile, 'utf8')) as Cache;
  } catch (err) {
    log.warn({ err: errMsg(err), path: cacheFile }, 'scope cache read failed; treating as empty');
    return {};
  }
}

function write(cache: Cache): void {
  try {
    writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  } catch (err) {
    log.warn({ err: errMsg(err), path: cacheFile }, 'scope cache write failed');
  }
}

export function getCodexThread(scopeKey: string): string | undefined {
  return read()[scopeKey]?.codexThreadId;
}

export function setCodexThread(scopeKey: string, codexThreadId: string): void {
  const cache = read();
  cache[scopeKey] = { codexThreadId, createdAt: new Date().toISOString() };
  write(cache);
}

export function discordScopeKey(threadChannelId: string): string {
  return `discord:${threadChannelId}`;
}
