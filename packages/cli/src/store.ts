import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_BASE = 'https://mcp.metro.box';
const DEFAULT_WEB = 'https://metro.box';

function fromEnv(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw === '' ? fallback : raw.replace(/\/+$/, '');
}

export function metroUrl(): string {
  return fromEnv('METRO_URL', DEFAULT_BASE);
}

export function metroWebUrl(): string {
  return fromEnv('METRO_UI_URL', DEFAULT_WEB);
}

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg === undefined || xdg === '' ? join(homedir(), '.config') : xdg;
  return join(base, 'metro');
}

export function credentialsPath(): string {
  return join(configDir(), 'credentials.json');
}

interface Stored {
  token: string;
  url: string;
}

function readStoredAt(path: string): Stored | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { token, url } = parsed as Record<string, unknown>;
  if (typeof token !== 'string' || token === '') return null;
  return { token, url: typeof url === 'string' ? url : DEFAULT_BASE };
}

const readStored = (): Stored | null => readStoredAt(credentialsPath());

const RUN_TOKEN_FILE = /^runtime-[A-Za-z0-9_-]{11}\.json$/;

export function readRunTokens(): string[] {
  const fromEnv = process.env.METRO_RUN_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return [fromEnv];
  let names: string[];
  try {
    names = readdirSync(configDir());
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (!RUN_TOKEN_FILE.test(name)) continue;
    const stored = readStoredAt(join(configDir(), name));
    if (stored !== null && stored.url === metroUrl()) out.push(stored.token);
  }
  return out;
}

export function readToken(): string | null {
  const fromEnv = process.env.METRO_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const stored = readStored();
  if (stored === null) return null;
  return stored.url === metroUrl() ? stored.token : null;
}

export function writeToken(token: string): void {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ token, url: metroUrl() })}\n`, {
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

export function clearToken(): void {
  try {
    rmSync(credentialsPath());
  } catch {
    return;
  }
}
