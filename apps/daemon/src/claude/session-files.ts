import { existsSync, statSync } from '../agent-user/agent-fs.js';
import { Transform, type Readable } from 'node:stream';
import { moveHome, receiveHomeFile, removeHome } from '../agent-user/home-fs.js';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { isRecord } from '@metro-labs/core/is-record';
import { claudeDir, PROJECT_RE, safeName, SESSION_RE } from './files.js';

const SESSION_FILE_MAX = 512 * 1024 * 1024;
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

const HEAD_BYTES = 64 * 1024;

function watched(body: Readable, head: Buffer[]): Transform {
  let total = 0;
  let kept = 0;
  const check = new Transform({
    transform(chunk: Buffer, _enc, done): void {
      total += chunk.length;
      if (total > SESSION_FILE_MAX) {
        done(new ApiError(`a session file is at most ${String(SESSION_FILE_MAX)} bytes`, 413));
        return;
      }
      if (kept < HEAD_BYTES) {
        head.push(chunk.subarray(0, HEAD_BYTES - kept));
        kept += chunk.length;
      }
      done(null, chunk);
    },
  });
  return body.pipe(check);
}

export async function receiveSessionFile(project: string, session: string, body: Readable, dir = claudeDir()): Promise<SessionFile> {
  const path = transcriptPath(project, session, dir);
  const tmp = `${path}.metro-upload`;
  const head: Buffer[] = [];
  try {
    await receiveHomeFile(tmp, watched(body, head), FILE_MODE);
  } catch (err) {
    removeHome(tmp);
    throw err;
  }
  if (!firstLineIsJson(Buffer.concat(head).toString('utf8'))) {
    removeHome(tmp);
    throw new ApiError('a session file is JSON lines, one Claude Code entry per line', 400);
  }
  moveHome(tmp, path);
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
