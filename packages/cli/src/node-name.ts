import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentsDir } from './local.js';

const NODE_FILE = '.node';
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const NAME_RE = /^metro-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RENAME_WAIT_MS = 30_000;
const RENAME_POLL_MS = 500;
const renameWaitMs = (): number => Number(process.env.METRO_NODE_RENAME_WAIT_MS) || RENAME_WAIT_MS;

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const stderrLine = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export function newNodeName(): string {
  const bytes = randomBytes(6);
  return `metro-${[...bytes].map((b) => ALPHABET[b % ALPHABET.length] ?? 'x').join('')}`;
}

export function nodeName(dir = agentsDir()): string {
  const path = join(dir, NODE_FILE);
  if (existsSync(path)) {
    const held = readFileSync(path, 'utf8').trim();
    if (NAME_RE.test(held)) return held;
  }
  const name = newNodeName();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${name}\n`, { mode: 0o600 });
  return name;
}

export function currentNodeLabel(bin: string): string | null {
  const run = spawnSync(bin, ['status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (run.error !== undefined || run.status !== 0) return null;
  try {
    const parsed = JSON.parse(run.stdout) as { Self?: { DNSName?: unknown } };
    const dns = typeof parsed.Self?.DNSName === 'string' ? parsed.Self.DNSName : '';
    const label = dns.split('.')[0] ?? '';
    return label === '' ? null : label.toLowerCase();
  } catch {
    return null;
  }
}

function awaitRename(bin: string, wanted: string, warn: (line: string) => void): void {
  const wait = renameWaitMs();
  const until = Date.now() + wait;
  while (Date.now() < until) {
    if (currentNodeLabel(bin) === wanted) return;
    pause(RENAME_POLL_MS);
  }
  warn(
    `tailscale still reports the old machine name after ${String(Math.round(wait / 1000))}s; the Funnel address may come up under it until the next restart`,
  );
}

export function ensureNodeName(bin: string, dir = agentsDir(), warn: (line: string) => void = stderrLine): string {
  const wanted = nodeName(dir);
  if (currentNodeLabel(bin) === wanted) return wanted;
  const run = spawnSync(bin, ['set', '--hostname', wanted], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.error !== undefined || run.status !== 0) {
    const said = run.stderr.trim();
    const reason = said === '' ? (run.error?.message ?? `exit ${String(run.status)}`) : said;
    throw new Error(
      `could not name this machine ${wanted} on your tailnet (${reason}).\n` +
        `Run it once yourself, then start again:  sudo tailscale set --hostname ${wanted}`,
    );
  }
  awaitRename(bin, wanted, warn);
  return wanted;
}
