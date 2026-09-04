import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errMsg, log } from './log.js';
import { readJson } from './secure-fs.js';

const RESTART_DELAY_MS = 2_000;
const RESTART_DELAY_MAX_MS = 30_000;
const TAKEN_RE = /listener already exists/i;
const FUNNEL_ON_RE = /\(Funnel on\)/i;

export const tunnelWanted = (): boolean => process.env.METRO_TUNNEL?.trim() === 'tailscale';

const FUNNEL_URL_RE = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net(?::\d{2,5})?(?=[\s/]|$)/i;
const SILENT_MS = 20_000;

export const funnelUrlIn = (text: string): string | null =>
  FUNNEL_URL_RE.exec(text)?.[0]?.toLowerCase() ?? null;

export interface Adopted {
  url: string | null;
  hint: string;
}

export interface TunnelDriver {
  name: string;
  command: string;
  args: string[];
  urlIn: (text: string) => string | null;
  waitsForDns: boolean;
  adopt?: () => Promise<Adopted>;
}

const runText = (command: string, args: string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', timeout: 10_000 }, (_err, stdout, stderr) => {
      resolve(`${stdout}\n${stderr}`);
    });
  });

export type Probe = (url: string) => Promise<boolean>;

const PROBE_MS = 5_000;

export async function daemonAnswersAt(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, PROBE_MS);
  try {
    const res = await fetch(`${url}/api/mode`, { signal: controller.signal });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null && (body as { mode?: unknown }).mode === 'local';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function nodeNameIn(statusJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(statusJson);
    const self = typeof parsed === 'object' && parsed !== null ? (parsed as { Self?: { DNSName?: unknown } }).Self : undefined;
    const name = typeof self?.DNSName === 'string' ? self.DNSName.replace(/\.$/, '').toLowerCase() : '';
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

async function adoptFunnel(bin: string, port: number, probe: Probe): Promise<Adopted> {
  const name = nodeNameIn(await runText(bin, ['status', '--json']));
  if (name !== null) {
    const url = `https://${name}`;
    if (await probe(url)) return { url, hint: `a Funnel already publishes this daemon at ${url}; using it` };
  }
  return funnelAlreadyServing(await runText(bin, ['funnel', 'status']), port);
}

export function funnelAlreadyServing(status: string, port: number): Adopted {
  const lines = status.split('\n');
  const target = `http://127.0.0.1:${String(port)}`;
  for (const [i, line] of lines.entries()) {
    if (line.trimStart().startsWith('#')) continue;
    const url = funnelUrlIn(line);
    if (url === null) continue;
    const body = lines.slice(i + 1, i + 6).join('\n');
    if (!body.includes(target)) continue;
    if (FUNNEL_ON_RE.test(line)) return { url, hint: `a Funnel already publishes this daemon at ${url}; using it` };
    return {
      url: null,
      hint: `${url} is a tailnet-only serve config on this node, not a Funnel; run: tailscale serve reset`,
    };
  }
  return { url: null, hint: 'port 443 is held by another serve config on this node; run: tailscale serve reset' };
}

function tailscaleBin(): string {
  const configured = process.env.METRO_TAILSCALE_BIN?.trim() ?? '';
  return configured === '' ? 'tailscale' : configured;
}

export const funnelDriver = (port: number, bin = tailscaleBin(), probe: Probe = daemonAnswersAt): TunnelDriver => ({
  name: 'tailscale funnel',
  command: bin,
  args: ['funnel', String(port)],
  urlIn: funnelUrlIn,
  waitsForDns: true,
  adopt: () => adoptFunnel(bin, port, probe),
});

let liveUrl: string | null = null;

export const currentTunnelUrl = (): string | null => liveUrl;

export type Resolves = (host: string) => Promise<boolean>;

const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];
const RESOLVE_EVERY_MS = 3_000;
const RESOLVE_GIVE_UP_MS = 180_000;

async function resolvesAt(server: string, host: string): Promise<boolean> {
  const resolver = new Resolver();
  resolver.setServers([server]);
  const answers = await Promise.all([
    resolver.resolve4(host).catch(() => []),
    resolver.resolve6(host).catch(() => []),
  ]);
  return answers.some((a) => a.length > 0);
}

export async function resolvesPublicly(host: string): Promise<boolean> {
  const found = await Promise.all(PUBLIC_RESOLVERS.map((server) => resolvesAt(server, host)));
  return found.some(Boolean);
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
  private restartDelay = RESTART_DELAY_MS;

  constructor(
    private driver: TunnelDriver,
    private onUrl: (url: string) => void = () => undefined,
    private resolves: Resolves = resolvesPublicly,
  ) {}

  private noticeUrl(text: string): void {
    const url = this.driver.urlIn(text);
    if (url === null || url === liveUrl) return;
    liveUrl = url;
    this.restartDelay = RESTART_DELAY_MS;
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
      this.afterExit(code).catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, `${this.driver.name}: exit handling failed`);
      });
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

  private async afterExit(code: number | null): Promise<void> {
    const output = this.output.join('\n');
    if (this.driver.adopt !== undefined && TAKEN_RE.test(output)) {
      const found = await this.driver.adopt();
      if (this.closed) return;
      if (found.url !== null) {
        log.info({ url: found.url }, `${this.driver.name}: ${found.hint}`);
        this.noticeUrl(found.url);
        return;
      }
      log.error({ output }, `${this.driver.name}: ${found.hint}`);
    } else log.warn({ code, output: this.output.slice(-5).join('\n') }, `${this.driver.name} exited; restarting`);
    setTimeout(() => {
      this.start();
    }, this.restartDelay);
    this.restartDelay = Math.min(this.restartDelay * 2, RESTART_DELAY_MAX_MS);
  }

  stop(): void {
    this.closed = true;
    this.child?.kill('SIGINT');
    this.child = null;
  }
}
