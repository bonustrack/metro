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

interface NamedTunnel {
  name: string;
  hostname: string;
}

interface QuickTunnel {
  quick: true;
}

export type TunnelConfig = NamedTunnel | QuickTunnel;

const isQuick = (cfg: TunnelConfig): cfg is QuickTunnel => 'quick' in cfg;

export const tunnelConfigFromEnv = (): TunnelConfig | null =>
  process.env.METRO_TUNNEL?.trim() === 'quick' ? { quick: true } : null;

const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export const quickTunnelUrlIn = (text: string): string | null =>
  QUICK_URL_RE.exec(text)?.[0] ?? null;

let liveUrl: string | null = null;

export const currentTunnelUrl = (): string | null => liveUrl;

export function configuredTunnelHost(): string | null {
  const cfg = loadTunnelConfig();
  return cfg !== null && !isQuick(cfg) ? cfg.hostname : null;
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

interface Plan {
  args: string[];
  env: NodeJS.ProcessEnv;
  mode: string;
}

export class Tunnel {
  private child: ChildProcess | null = null;
  private closed = false;
  private token: string | null | undefined = undefined;

  constructor(
    private cfg: TunnelConfig,
    private port: number,
    private onUrl: (url: string) => void = () => undefined,
  ) {}

  get hostname(): string {
    if (!isQuick(this.cfg)) return this.cfg.hostname;
    return liveUrl === null ? '' : new URL(liveUrl).host;
  }

  private origin(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  private plan(): Plan {
    if (isQuick(this.cfg))
      return {
        args: ['--no-autoupdate', 'tunnel', '--url', this.origin()],
        env: process.env,
        mode: 'quick',
      };
    if (this.token === undefined) this.token = fetchTunnelToken(this.cfg.name);
    const args = ['--no-autoupdate', 'tunnel', 'run', '--url', this.origin()];
    if (!this.token) args.push(this.cfg.name);
    return {
      args,
      env: this.token ? { ...process.env, TUNNEL_TOKEN: this.token } : process.env,
      mode: this.token ? 'token' : 'named',
    };
  }

  private noticeUrl(text: string): void {
    if (!isQuick(this.cfg)) return;
    const url = quickTunnelUrlIn(text);
    if (url === null || url === liveUrl) return;
    liveUrl = url;
    log.info({ url }, 'quick tunnel up');
    this.onUrl(url);
  }

  start(): void {
    if (this.closed) return;
    const plan = this.plan();
    log.info(
      { tunnel: isQuick(this.cfg) ? 'quick' : this.cfg.name, port: this.port, mode: plan.mode },
      'cloudflared tunnel starting',
    );
    const child = spawn('cloudflared', plan.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: plan.env,
    });
    this.child = child;
    child.stderr?.on('data', (d: Buffer | string) => {
      const text = (typeof d === 'string' ? d : d.toString('utf8')).trim();
      log.debug({ cloudflared: text }, 'cloudflared');
      this.noticeUrl(text);
    });
    child.on('exit', (code) => {
      this.child = null;
      liveUrl = null;
      if (this.closed) return;
      log.warn({ code }, 'cloudflared exited; restarting');
      setTimeout(() => {
        this.start();
      }, RESTART_DELAY_MS);
    });
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.closed = true;
        log.error(
          'cloudflared is not installed, so there is no public address; install it and restart',
        );
        return;
      }
      log.warn({ err: errMsg(err) }, 'cloudflared spawn error');
    });
  }

  stop(): void {
    this.closed = true;
    this.child?.kill();
    this.child = null;
  }
}
