import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { agentsDir } from '../agents/files.js';
import { MCP_TOKEN_FILE } from '../mcp-server/token.js';
import { effectiveSetup, modelViewText } from '../gateway/effective.js';
import { removeHome, writeHomeText } from './home-fs.js';
import { closeMetroHome } from './metro-home.js';
import { agentUser, agentViewDir, type AgentUser } from './user.js';

const COPIED = ['policy.json', 'claude-setup.json', 'system-prompt.md'] as const;
const NEVER_COPIED = [MCP_TOKEN_FILE] as const;
const SYNC_MS = 5_000;

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

const readRecord = (path: string): Record<string, unknown> | null => {
  const text = readText(path);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function agentFile(dir: string): string | null {
  const file = readRecord(join(dir, 'agent.json'));
  if (file === null || typeof file.id !== 'string' || typeof file.key !== 'string') return null;
  return json({ version: 1, id: file.id, key: file.key });
}

export function viewFiles(dir = agentsDir(), model: () => string | null = () => modelViewText(effectiveSetup(dir))): Map<string, string | null> {
  const files = new Map<string, string | null>([
    ['agent.json', agentFile(dir)],
    ['model.json', model()],
  ]);
  for (const name of COPIED) files.set(name, existsSync(join(dir, name)) ? readText(join(dir, name)) : null);
  for (const name of NEVER_COPIED) files.set(name, null);
  return files;
}

const written = new Map<string, string | null>();

export function syncAgentView(user: AgentUser | null = agentUser(), dir = agentsDir()): number {
  if (user === null) return 0;
  const target = agentViewDir(user);
  let changed = 0;
  for (const [name, text] of viewFiles(dir)) {
    const path = join(target, name);
    if (written.has(path) && written.get(path) === text) continue;
    if (text === null) removeHome(path, false, user);
    else writeHomeText(path, text, 0o600, undefined, user);
    written.set(path, text);
    changed += 1;
  }
  return changed;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function watchAgentView(everyMs = SYNC_MS): void {
  if (timer !== null) return;
  const tick = (): void => {
    try {
      const changed = syncAgentView();
      if (changed > 0) log.info({ changed }, 'agent-user: refreshed the Metro files the agent may read');
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'agent-user: could not refresh the Metro files the agent may read');
    }
    try {
      closeMetroHome();
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'agent-user: could not close the metro home');
    }
  };
  tick();
  timer = setInterval(tick, everyMs);
  timer.unref();
}
