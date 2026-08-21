import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { STATE_DIR } from './paths.js';
import { errMsg, log } from './log.js';
import { readJson } from './secure-fs.js';

const FILE = join(STATE_DIR, 'tunnel.json');
const LEGACY_WEBHOOKS_FILE = join(STATE_DIR, 'webhooks.json');
const RESTART_DELAY_MS = 2_000;

export interface TunnelConfig {
  name: string;
  hostname: string;
}

export interface Endpoint {
  id: string;
  webhookId?: string;
  label: string;
  secret?: string;
  session?: string;
  createdAt: string;
}
interface AccountRecord {
  id?: unknown;
  webhookId?: unknown;
  label?: unknown;
  secret?: unknown;
  session?: unknown;
  createdAt?: unknown;
}

export const webhookPort = (): number =>
  Number(process.env.METRO_WEBHOOK_PORT) || 8420;

const accountsFile = (): string =>
  process.env.WEBHOOK_ACCOUNTS_FILE ??
  join(homedir(), '.metro', 'webhook-accounts.json');

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;

function toEndpoint(raw: AccountRecord): Endpoint | null {
  const id = str(raw.id);
  if (id === undefined) return null;
  return {
    id,
    webhookId: str(raw.webhookId),
    label: str(raw.label) ?? id,
    secret: str(raw.secret),
    session: str(raw.session),
    createdAt: str(raw.createdAt) ?? '',
  };
}

export function listEndpoints(): Endpoint[] {
  const raw = readJson<AccountRecord[]>(accountsFile(), [], {
    warn: 'webhook-accounts.json: malformed, ignoring',
  });
  if (!Array.isArray(raw)) return [];
  return raw.map(toEndpoint).filter((e): e is Endpoint => e !== null);
}

export const findEndpoint = (id: string): Endpoint | undefined =>
  listEndpoints().find((e) => e.id === id);

export const findEndpointByWebhookId = (
  webhookId: string,
): Endpoint | undefined =>
  listEndpoints().find((e) => e.webhookId === webhookId);

export function tokenMatches(secret: string, given: string): boolean {
  const want = Buffer.from(secret);
  const got = Buffer.from(given);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function warnOnLegacyWebhooks(): void {
  const legacy = readJson<{ endpoints?: unknown[] }>(LEGACY_WEBHOOKS_FILE, {});
  const count = Array.isArray(legacy.endpoints) ? legacy.endpoints.length : 0;
  if (count > 0)
    log.warn(
      { file: LEGACY_WEBHOOKS_FILE, endpoints: count },
      'webhook: webhooks.json is no longer read — endpoints live in the accounts table; these endpoints are inactive',
    );
}

export const loadTunnelConfig = (): TunnelConfig | null =>
  readJson<TunnelConfig | null>(FILE, null, {
    warn: 'tunnel.json: malformed, ignoring',
  });

function fetchTunnelToken(name: string): string | null {
  const r = spawnSync('cloudflared', ['tunnel', 'token', name], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  const token = r.stdout.trim();
  return token.length > 0 ? token : null;
}

export class Tunnel {
  private child: ChildProcess | null = null;
  private closed = false;
  private token: string | null | undefined = undefined;

  constructor(
    private cfg: TunnelConfig,
    private port: number,
  ) {}

  get hostname(): string {
    return this.cfg.hostname;
  }

  start(): void {
    if (this.closed) return;
    if (this.token === undefined) this.token = fetchTunnelToken(this.cfg.name);
    const mode = this.token ? 'token' : 'named';
    log.info(
      {
        name: this.cfg.name,
        hostname: this.cfg.hostname,
        port: this.port,
        mode,
      },
      'cloudflared tunnel starting',
    );
    const args = [
      '--no-autoupdate',
      'tunnel',
      'run',
      '--url',
      `http://127.0.0.1:${this.port}`,
    ];
    if (!this.token) args.push(this.cfg.name);
    const env = this.token
      ? { ...process.env, TUNNEL_TOKEN: this.token }
      : process.env;
    this.child = spawn('cloudflared', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    this.child.stderr?.on('data', (d: Buffer | string) => {
      log.debug(
        {
          cloudflared: (typeof d === 'string' ? d : d.toString('utf8')).trim(),
        },
        'cloudflared',
      );
    });
    this.child.on('exit', (code) => {
      this.child = null;
      if (this.closed) return;
      log.warn({ code }, 'cloudflared exited; restarting');
      setTimeout(() => {
        this.start();
      }, RESTART_DELAY_MS);
    });
    this.child.on('error', (err) => {
      log.warn({ err: errMsg(err) }, 'cloudflared spawn error');
    });
  }

  stop(): void {
    this.closed = true;
    this.child?.kill();
    this.child = null;
  }
}
