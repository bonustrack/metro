import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentsDir } from './local.js';

const NODE_FILE = '.node';
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const NAME_RE = /^metro-[a-z0-9]{6}$/;

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

export function ensureNodeName(bin: string, dir = agentsDir()): string {
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
  return wanted;
}
