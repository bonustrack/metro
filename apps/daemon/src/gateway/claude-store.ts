import { join } from 'node:path';
import { ID_RE } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { readJson, writeSecure } from '@metro-labs/core/secure-fs';
import { agentsDir } from '../agents/files.js';

export interface ClaudeLogin {
  id: string;
  email: string | null;
  plan: string | null;
  savedAt: string;
}

const MODEL_FILE = 'model.json';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const maybe = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function claudeLoginOf(raw: unknown): ClaudeLogin | null {
  if (!isRecord(raw) || !ID_RE.test(text(raw.id))) return null;
  return { id: text(raw.id), email: maybe(raw.email), plan: maybe(raw.plan), savedAt: text(raw.savedAt) };
}

const modelPath = (dir: string): string => join(dir, MODEL_FILE);

const readModelFile = (dir: string): unknown =>
  readJson<unknown>(modelPath(dir), null, { warn: 'model.json is unreadable, so the Claude logins of this box are not seen until it is fixed' });

const isV2 = (raw: unknown): raw is Record<string, unknown> & { connections: unknown[] } =>
  isRecord(raw) && raw.version !== 3 && Array.isArray(raw.connections);

const unique = (logins: ClaudeLogin[]): ClaudeLogin[] => logins.filter((l, at) => logins.findIndex((o) => o.id === l.id) === at);

function claudeLoginsIn(raw: unknown): ClaudeLogin[] {
  if (isV2(raw)) return unique(raw.connections.flatMap((c: unknown) => (isRecord(c) && c.provider === 'anthropic' ? (claudeLoginOf(c.claude) ?? []) : [])));
  if (!isRecord(raw) || !Array.isArray(raw.claude)) return [];
  return unique(raw.claude.flatMap((c: unknown) => claudeLoginOf(c) ?? []));
}

export const readClaudeLogins = (dir = agentsDir()): ClaudeLogin[] => claudeLoginsIn(readModelFile(dir));

export function writeClaudeLogins(logins: ClaudeLogin[], dir = agentsDir()): void {
  writeSecure(modelPath(dir), JSON.stringify({ version: 3, claude: logins }, null, 2));
}

export function retireV2ModelFile(dir = agentsDir()): boolean {
  try {
    const raw = readModelFile(dir);
    if (!isV2(raw)) return false;
    const logins = claudeLoginsIn(raw);
    writeClaudeLogins(logins, dir);
    log.warn({ claudeLogins: logins.length, connections: raw.connections.length }, 'org-models: model.json was still the old version 2; it keeps only its Claude logins now, and its connections are never served');
    return true;
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'org-models: the old version 2 model.json could not be rewritten; its connections are never served');
    return false;
  }
}
