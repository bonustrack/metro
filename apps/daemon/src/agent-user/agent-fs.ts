import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { runningAsMetro } from '../metro-user/privilege.js';
import { agentUser, asUser, type AgentUser } from './user.js';

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

const codeOf = (err: unknown): unknown => (err as { code?: unknown } | null)?.code;

const refused = (err: unknown): boolean => {
  const code = codeOf(err);
  return (code === 'EACCES' || code === 'EPERM') && runningAsMetro();
};

const realHome = new Map<string, string>();

function homeOf(user: AgentUser): string {
  let real = realHome.get(user.home);
  if (real === undefined) {
    try {
      real = fs.realpathSync(user.home);
    } catch {
      real = resolve(user.home);
    }
    realHome.set(user.home, real);
  }
  return real;
}

const within = (home: string, path: string): boolean => path === home || path.startsWith(`${home}${sep}`);

function realOf(path: string, fd: number | undefined): string | null {
  if (fd !== undefined) return fs.readlinkSync(`/proc/self/fd/${String(fd)}`);
  try {
    return fs.realpathSync(path);
  } catch (err) {
    if (codeOf(err) === 'ENOENT' || codeOf(err) === 'ENOTDIR') return null;
    throw err;
  }
}

export function escapesHome(path: string, user: AgentUser, fd?: number): boolean {
  const home = homeOf(user);
  const asked = resolve(path);
  if (!within(resolve(user.home), asked) && !within(home, asked)) return false;
  const real = realOf(path, fd);
  return real !== null && !within(home, real);
}

const confinedUser = (): AgentUser | null => (runningAsMetro() ? agentUser() : null);

function outside(path: string): Error {
  const err = new Error(`${path} leads out of the agent's home, so metro reads it as the agent`) as Error & { code: string };
  err.code = 'EACCES';
  return err;
}

function guardPath(path: string, fd?: number): void {
  const user = confinedUser();
  if (user !== null && escapesHome(path, user, fd)) throw outside(path);
}

function openGuarded(path: string): number {
  const fd = fs.openSync(path, 'r');
  try {
    guardPath(path, fd);
    return fd;
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

function asAgentSh(script: string, args: string[], failure = 'ENOENT'): Buffer {
  const [file, argv] = asUser(agentUser(), 'sh', ['-c', script, 'metro', ...args]);
  const run = spawnSync(file, argv, { maxBuffer: MAX_OUTPUT, stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) {
    const err = new Error(run.stderr.toString('utf8').trim() || `no such file or directory, ${args[0] ?? ''}`) as Error & { code: string };
    err.code = run.status === 66 ? 'ENOENT' : failure;
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
    guardPath(path);
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

export const statSync = (path: string): AgentStat =>
  viaAgent(
    () => {
      guardPath(path);
      return fs.statSync(path);
    },
    () => agentStat(path, true),
  );

export const realpathSync = (path: string): string =>
  viaAgent(
    () => {
      guardPath(path);
      return fs.realpathSync(path);
    },
    () => asAgentSh('realpath -e -- "$1"', [path]).toString('utf8').trim(),
  );

export function readFileSync(path: string, encoding: 'utf8'): string {
  return viaAgent(
    () => {
      const fd = openGuarded(path);
      try {
        return fs.readFileSync(fd, encoding);
      } finally {
        fs.closeSync(fd);
      }
    },
    () => asAgentSh('if test -x "${1%/*}" && ! test -e "$1" && ! test -L "$1"; then exit 66; fi; cat -- "$1"', [path], 'EIO').toString('utf8'),
  );
}

export function readRange(path: string, start: number, length: number): Buffer {
  return viaAgent(
    () => {
      const fd = openGuarded(path);
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
    () => {
      guardPath(path);
      return fs.readdirSync(path, { withFileTypes: true });
    },
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
    return fs.createReadStream(path, { fd: openGuarded(path) });
  } catch (err) {
    if (!refused(err)) return fs.createReadStream(path);
    const [file, argv] = asUser(agentUser(), 'cat', ['--', path]);
    const child = spawn(file, argv, { stdio: ['ignore', 'pipe', 'ignore'] });
    return child.stdout;
  }
}

export function readAsAgent(path: string, maxBytes: number): Buffer | null {
  if (!runningAsMetro() || agentUser() === null) {
    try {
      const st = fs.statSync(path);
      if (!st.isFile()) return null;
      const start = Math.max(0, st.size - maxBytes);
      const fd = fs.openSync(path, 'r');
      try {
        const buffer = Buffer.alloc(st.size - start);
        return buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, start));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }
  try {
    return asAgentSh('[ -f "$1" ] && tail -c "$2" -- "$1"', [path, String(maxBytes)]);
  } catch {
    return null;
  }
}
