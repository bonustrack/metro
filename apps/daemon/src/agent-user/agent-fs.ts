import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import type { Readable } from 'node:stream';
import { runningAsMetro } from '../metro-user/privilege.js';
import { agentUser, asUser } from './user.js';

export interface AgentStat {
  size: number;
  mtime: Date;
  mtimeMs: number;
  mode: number;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
}

export interface AgentDirent {
  name: string;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
}

const MAX_OUTPUT = 256 * 1024 * 1024;

const refused = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code;
  return (code === 'EACCES' || code === 'EPERM') && runningAsMetro();
};

function asAgentSh(script: string, args: string[]): Buffer {
  const [file, argv] = asUser(agentUser(), 'sh', ['-c', script, 'metro', ...args]);
  const run = spawnSync(file, argv, { maxBuffer: MAX_OUTPUT, stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) {
    const err = new Error(run.stderr.toString('utf8').trim() || `no such file or directory, ${args[0] ?? ''}`) as Error & { code: string };
    err.code = 'ENOENT';
    throw err;
  }
  return run.stdout;
}

function viaAgent<T>(native: () => T, fallback: () => T): T {
  try {
    return native();
  } catch (err) {
    if (!refused(err)) throw err;
    return fallback();
  }
}

export function existsSync(path: string): boolean {
  try {
    fs.accessSync(path, fs.constants.F_OK);
    return true;
  } catch (err) {
    if (!refused(err)) return false;
    try {
      asAgentSh('test -e "$1"', [path]);
      return true;
    } catch {
      return false;
    }
  }
}

const kindTests = (kind: string): Pick<AgentStat, 'isFile' | 'isDirectory' | 'isSymbolicLink'> => ({
  isFile: () => kind === 'f',
  isDirectory: () => kind === 'd',
  isSymbolicLink: () => kind === 'l',
});

function agentStat(path: string, follow: boolean): AgentStat {
  const out = asAgentSh(`stat ${follow ? '-L ' : ''}-c "%s %Y %f %F" -- "$1"`, [path]).toString('utf8').trim();
  const [size = '0', mtime = '0', mode = '0', ...type] = out.split(' ');
  const kind = type.join(' ') === 'directory' ? 'd' : type.join(' ') === 'symbolic link' ? 'l' : 'f';
  const ms = Number(mtime) * 1000;
  return { size: Number(size), mtime: new Date(ms), mtimeMs: ms, mode: parseInt(mode, 16), ...kindTests(kind) };
}

export const statSync = (path: string): AgentStat => viaAgent(() => fs.statSync(path), () => agentStat(path, true));

export const realpathSync = (path: string): string =>
  viaAgent(() => fs.realpathSync(path), () => asAgentSh('realpath -e -- "$1"', [path]).toString('utf8').trim());

export function readFileSync(path: string, encoding: 'utf8'): string {
  return viaAgent(() => fs.readFileSync(path, encoding), () => asAgentSh('cat -- "$1"', [path]).toString('utf8'));
}

export function readRange(path: string, start: number, length: number): Buffer {
  return viaAgent(
    () => {
      const fd = fs.openSync(path, 'r');
      try {
        const buffer = Buffer.alloc(length);
        return buffer.subarray(0, fs.readSync(fd, buffer, 0, length, start));
      } finally {
        fs.closeSync(fd);
      }
    },
    () => asAgentSh('tail -c +"$2" -- "$1" | head -c "$3"', [path, String(start + 1), String(length)]),
  );
}

export function readdirNames(path: string): string[] {
  return readdirEntries(path).map((e) => e.name);
}

export function readdirEntries(path: string): AgentDirent[] {
  return viaAgent(
    () => fs.readdirSync(path, { withFileTypes: true }),
    () =>
      asAgentSh('find -H "$1" -mindepth 1 -maxdepth 1 -printf "%y\\t%f\\0"', [path])
        .toString('utf8')
        .split('\0')
        .filter((line) => line.includes('\t'))
        .map((line) => {
          const at = line.indexOf('\t');
          return { name: line.slice(at + 1), ...kindTests(line.slice(0, at)) };
        }),
  );
}

export function createReadStream(path: string): Readable {
  try {
    fs.accessSync(path, fs.constants.R_OK);
    return fs.createReadStream(path);
  } catch (err) {
    if (!refused(err)) return fs.createReadStream(path);
    const [file, argv] = asUser(agentUser(), 'cat', ['--', path]);
    const child = spawn(file, argv, { stdio: ['ignore', 'pipe', 'ignore'] });
    return child.stdout;
  }
}
