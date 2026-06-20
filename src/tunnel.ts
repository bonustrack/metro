import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './paths.js';
import { errMsg, log } from './log.js';

const FILE = join(STATE_DIR, 'tunnel.json');
const RESTART_DELAY_MS = 2_000;

export interface TunnelConfig {
  name: string;
  hostname: string;
}

export const loadTunnelConfig = (): TunnelConfig | null => {
  if (!existsSync(FILE)) return null;
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as TunnelConfig;
  } catch (err) {
    log.warn(
      { err: errMsg(err), path: FILE },
      'tunnel.json: malformed, ignoring',
    );
    return null;
  }
};

export function saveTunnelConfig(c: TunnelConfig): void {
  writeFileSync(FILE, JSON.stringify(c, null, 2));
}

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

const WEBHOOKS_FILE = join(STATE_DIR, 'webhooks.json');

export interface Endpoint {
  id: string;
  label: string;
  secret?: string;
  session?: string;
  createdAt: string;
}
interface Store {
  endpoints: Endpoint[];
}

export const webhookPort = (): number =>
  Number(process.env.METRO_WEBHOOK_PORT) || 8420;

function readWebhooks(): Store {
  if (!existsSync(WEBHOOKS_FILE)) return { endpoints: [] };
  try {
    return JSON.parse(readFileSync(WEBHOOKS_FILE, 'utf8')) as Store;
  } catch {
    return { endpoints: [] };
  }
}
const writeWebhooks = (s: Store): void => {
  writeFileSync(WEBHOOKS_FILE, JSON.stringify(s, null, 2));
};

export const listEndpoints = (): Endpoint[] => readWebhooks().endpoints;
export const findEndpoint = (id: string): Endpoint | undefined =>
  readWebhooks().endpoints.find((e) => e.id === id);

export function addEndpoint(
  label: string,
  secret?: string,
  session?: string,
): Endpoint {
  const s = readWebhooks();
  const ep: Endpoint = {
    id: randomBytes(12).toString('base64url'),
    label,
    createdAt: new Date().toISOString(),
    ...(secret ? { secret } : {}),
    ...(session ? { session } : {}),
  };
  s.endpoints.push(ep);
  writeWebhooks(s);
  return ep;
}

export function removeEndpoint(id: string): boolean {
  const s = readWebhooks();
  const before = s.endpoints.length;
  s.endpoints = s.endpoints.filter((e) => e.id !== id);
  if (s.endpoints.length === before) return false;
  writeWebhooks(s);
  return true;
}
