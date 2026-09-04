import { spawn, type ChildProcess } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errMsg, log } from './log.js';
import { readJson } from './secure-fs.js';

const RESTART_DELAY_MS = 2_000;

export type TunnelKind = 'quick' | 'tailscale';

export function tunnelKind(): TunnelKind | null {
  const raw = process.env.METRO_TUNNEL?.trim();
  return raw === 'quick' || raw === 'tailscale' ? raw : null;
}

export const quickTunnelWanted = (): boolean => tunnelKind() === 'quick';

const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const FUNNEL_URL_RE = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net(?::\d{2,5})?(?=[\s/]|$)/i;
const SILENT_MS = 20_000;

export const quickTunnelUrlIn = (text: string): string | null =>
  QUICK_URL_RE.exec(text)?.[0] ?? null;

export const funnelUrlIn = (text: string): string | null =>
  FUNNEL_URL_RE.exec(text)?.[0]?.toLowerCase() ?? null;

export interface TunnelDriver {
  name: string;
  command: string;
  args: string[];
  urlIn: (text: string) => string | null;
  waitsForDns: boolean;
}

export const quickDriver = (port: number): TunnelDriver => ({
  name: 'cloudflared quick tunnel',
  command: 'cloudflared',
  args: ['--no-autoupdate', 'tunnel', '--url', `http://127.0.0.1:${String(port)}`],
  urlIn: quickTunnelUrlIn,
  waitsForDns: true,
});

function tailscaleBin(): string {
  const configured = process.env.METRO_TAILSCALE_BIN?.trim() ?? '';
  return configured === '' ? 'tailscale' : configured;
}

export const funnelDriver = (port: number, bin = tailscaleBin()): TunnelDriver => ({
  name: 'tailscale funnel',
  command: bin,
  args: ['funnel', String(port)],
  urlIn: funnelUrlIn,
  waitsForDns: true,
});

export const driverFor = (kind: TunnelKind, port: number): TunnelDriver =>
  kind === 'quick' ? quickDriver(port) : funnelDriver(port);

let liveUrl: string | null = null;

export const currentTunnelUrl = (): string | null => liveUrl;

export type Resolves = (host: string) => Promise<boolean>;

const PUBLIC_RESOLVERS = ['1.1.1.1', '1.0.0.1'];
const RESOLVE_EVERY_MS = 3_000;
const RESOLVE_GIVE_UP_MS = 180_000;

export async function resolvesAtCloudflare(host: string): Promise<boolean> {
  const resolver = new Resolver();
  resolver.setServers(PUBLIC_RESOLVERS);
  try {
    return (await resolver.resolve4(host)).length > 0;
  } catch {
    return false;
  }
}

async function untilResolvable(host: string, resolves: Resolves): Promise<boolean> {
  const deadline = Date.now() + RESOLVE_GIVE_UP_MS;
  while (Date.now() < deadline) {
    if (await resolves(host)) return true;
    await new Promise((r) => setTimeout(r, RESOLVE_EVERY_MS));
  }
  return false;
}

export interface Endpoint {
  id: string;
  webhookId?: string;
  label: string;
  secret?: string;
  createdAt: string;
}
interface AccountRecord {
  id?: unknown;
  webhookId?: unknown;
  label?: unknown;
  secret?: unknown;
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

export class Tunnel {
  private child: ChildProcess | null = null;
  private closed = false;
  private output: string[] = [];

  constructor(
    private driver: TunnelDriver,
    private onUrl: (url: string) => void = () => undefined,
    private resolves: Resolves = resolvesAtCloudflare,
  ) {}

  private noticeUrl(text: string): void {
    const url = this.driver.urlIn(text);
    if (url === null || url === liveUrl) return;
    liveUrl = url;
    if (!this.driver.waitsForDns) {
      log.info({ url }, `${this.driver.name} up`);
      this.onUrl(url);
      return;
    }
    log.info({ url }, `${this.driver.name} up; waiting for its name to resolve`);
    this.announceWhenResolvable(url).catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, `${this.driver.name}: announce failed`);
    });
  }

  private async announceWhenResolvable(url: string): Promise<void> {
    const resolved = await untilResolvable(new URL(url).host, this.resolves);
    if (liveUrl !== url) return;
    if (!resolved) log.warn({ url }, `${this.driver.name} name still not resolving; announcing anyway`);
    this.onUrl(url);
  }

  private read(d: Buffer | string): void {
    const text = (typeof d === 'string' ? d : d.toString('utf8')).trim();
    if (text === '') return;
    this.output.push(text);
    log.debug({ output: text }, this.driver.name);
    this.noticeUrl(text);
  }

  private silentCheck(): void {
    if (this.closed || liveUrl !== null || this.child === null) return;
    log.warn(
      { output: this.output.join('\n') },
      `${this.driver.name}: no public address after ${String(SILENT_MS / 1000)}s; its own output follows`,
    );
  }

  start(): void {
    if (this.closed) return;
    log.info({ command: this.driver.command, args: this.driver.args }, `${this.driver.name} starting`);
    this.output = [];
    const child = spawn(this.driver.command, this.driver.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout?.on('data', (d: Buffer | string) => {
      this.read(d);
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      this.read(d);
    });
    setTimeout(() => {
      this.silentCheck();
    }, SILENT_MS).unref();
    child.on('exit', (code) => {
      this.child = null;
      liveUrl = null;
      if (this.closed) return;
      log.warn({ code, output: this.output.slice(-5).join('\n') }, `${this.driver.name} exited; restarting`);
      setTimeout(() => {
        this.start();
      }, RESTART_DELAY_MS);
    });
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.closed = true;
        log.error(
          { command: this.driver.command },
          `${this.driver.name}: the binary is not installed, so there is no public address; install it and restart`,
        );
        return;
      }
      log.warn({ err: errMsg(err) }, `${this.driver.name} spawn error`);
    });
  }

  stop(): void {
    this.closed = true;
    this.child?.kill('SIGINT');
    this.child = null;
  }
}
