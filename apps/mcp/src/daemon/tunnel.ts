import { spawn, type ChildProcess } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errMsg, log } from './log.js';
import { readJson } from './secure-fs.js';

const RESTART_DELAY_MS = 2_000;

export const quickTunnelWanted = (): boolean =>
  process.env.METRO_TUNNEL?.trim() === 'quick';

const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export const quickTunnelUrlIn = (text: string): string | null =>
  QUICK_URL_RE.exec(text)?.[0] ?? null;

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

  constructor(
    private port: number,
    private onUrl: (url: string) => void = () => undefined,
    private resolves: Resolves = resolvesAtCloudflare,
  ) {}

  private origin(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  private noticeUrl(text: string): void {
    const url = quickTunnelUrlIn(text);
    if (url === null || url === liveUrl) return;
    liveUrl = url;
    log.info({ url }, 'quick tunnel up; waiting for its name to resolve');
    this.announceWhenResolvable(url).catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'quick tunnel: announce failed');
    });
  }

  private async announceWhenResolvable(url: string): Promise<void> {
    const resolved = await untilResolvable(new URL(url).host, this.resolves);
    if (liveUrl !== url) return;
    if (!resolved) log.warn({ url }, 'quick tunnel name still not resolving; announcing anyway');
    this.onUrl(url);
  }

  start(): void {
    if (this.closed) return;
    log.info({ port: this.port }, 'cloudflared quick tunnel starting');
    const child = spawn(
      'cloudflared',
      ['--no-autoupdate', 'tunnel', '--url', this.origin()],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
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
