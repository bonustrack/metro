import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { isRecord } from '@metro-labs/core/is-record';
import { claudeDir, PROJECT_RE, safeName, SESSION_RE } from './files.js';

export const SESSION_FILE_MAX = 512 * 1024 * 1024;
const FILE_MODE = 0o644;

export interface SessionFile {
  id: string;
  bytes: number;
}

const transcriptPath = (project: string, session: string, dir: string): string =>
  join(dir, 'projects', safeName(project, PROJECT_RE, 'Claude project id'), `${safeName(session, SESSION_RE, 'session id')}.jsonl`);

export function sessionFilePath(project: string, session: string, dir = claudeDir()): string {
  const path = transcriptPath(project, session, dir);
  if (!existsSync(path)) throw new ApiError('no such session', 404);
  if (statSync(path).size > SESSION_FILE_MAX) throw new ApiError(`a session file is at most ${String(SESSION_FILE_MAX)} bytes`, 400);
  return path;
}

export function readSessionFile(project: string, session: string, dir = claudeDir()): string {
  return readFileSync(sessionFilePath(project, session, dir), 'utf8');
}

const HEAD_BYTES = 64 * 1024;

async function spool(body: Readable, tmp: string): Promise<string> {
  const out = createWriteStream(tmp, { mode: FILE_MODE });
  const head: Buffer[] = [];
  let total = 0;
  let kept = 0;
  for await (const chunk of body) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > SESSION_FILE_MAX) {
      out.destroy();
      rmSync(tmp, { force: true });
      throw new ApiError(`a session file is at most ${String(SESSION_FILE_MAX)} bytes`, 413);
    }
    if (kept < HEAD_BYTES) {
      head.push(buf.subarray(0, HEAD_BYTES - kept));
      kept += buf.length;
    }
    if (!out.write(buf)) await new Promise<void>((r) => out.once('drain', r));
  }
  await new Promise<void>((resolve, reject) => {
    out.once('error', reject);
    out.end(resolve);
  });
  return Buffer.concat(head).toString('utf8');
}

export async function receiveSessionFile(project: string, session: string, body: Readable, dir = claudeDir()): Promise<SessionFile> {
  const path = transcriptPath(project, session, dir);
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.metro-${String(process.pid)}`;
  const head = await spool(body, tmp);
  if (!firstLineIsJson(head)) {
    rmSync(tmp, { force: true });
    throw new ApiError('a session file is JSON lines, one Claude Code entry per line', 400);
  }
  renameSync(tmp, path);
  return { id: safeName(session, SESSION_RE, 'session id'), bytes: statSync(path).size };
}

function firstLineIsJson(text: string): boolean {
  const first = text.split('\n').find((line) => line.trim() !== '');
  if (first === undefined) return false;
  try {
    return isRecord(JSON.parse(first));
  } catch {
    return false;
  }
}

export function writeSessionFile(project: string, session: string, text: string, dir = claudeDir()): SessionFile {
  if (!firstLineIsJson(text)) throw new ApiError('a session file is JSON lines, one Claude Code entry per line', 400);
  if (Buffer.byteLength(text, 'utf8') > SESSION_FILE_MAX) throw new ApiError(`a session file is at most ${String(SESSION_FILE_MAX)} bytes`, 400);
  const path = transcriptPath(project, session, dir);
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.metro-${String(process.pid)}`;
  writeFileSync(tmp, text, { mode: FILE_MODE });
  renameSync(tmp, path);
  return { id: safeName(session, SESSION_RE, 'session id'), bytes: statSync(path).size };
}
