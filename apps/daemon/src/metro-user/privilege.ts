import { spawnSync } from 'node:child_process';
import { HELPER_PATH, METRO_USER } from './helper-script.js';

export interface PrivilegeHost {
  platform: string;
  uid: number | undefined;
  user: string;
}

let metroUid: number | null | undefined;

function uidOfMetro(): number | null {
  if (metroUid !== undefined) return metroUid;
  const run = spawnSync('getent', ['passwd', METRO_USER], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const uid = Number(run.status === 0 ? run.stdout.split(':')[2] : NaN);
  metroUid = Number.isInteger(uid) && uid > 0 ? uid : null;
  return metroUid;
}

const realHost = (): PrivilegeHost => {
  const uid = process.getuid?.();
  const linux = process.platform === 'linux';
  return { platform: process.platform, uid, user: linux && uid !== 0 && uid !== undefined && uid === uidOfMetro() ? METRO_USER : '' };
};

export const runningAsRoot = (host: PrivilegeHost = realHost()): boolean => host.platform === 'linux' && host.uid === 0;

export const runningAsMetro = (host: PrivilegeHost = realHost()): boolean =>
  host.platform === 'linux' && host.uid !== 0 && host.user === METRO_USER;

export interface HelperResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function rootHelper(args: string[], input?: string): HelperResult {
  const run = spawnSync('sudo', ['-n', HELPER_PATH, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 180_000 });
  return { status: run.error === undefined ? run.status : null, stdout: run.stdout ?? '', stderr: run.stderr ?? run.error?.message ?? '' };
}

export function mustHelper(args: string[], input?: string): string {
  const run = rootHelper(args, input);
  if (run.status !== 0) throw new Error(run.stderr.trim() || `root-helper ${args[0] ?? ''} failed`);
  return run.stdout;
}

export const helperArgv = (args: string[]): [string, string[]] => ['sudo', ['-n', HELPER_PATH, ...args]];
