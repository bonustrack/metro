import { log } from '@metro-labs/core/log';
import type { AwsKeys } from './aws/ec2.js';
import type { TailscaleClient } from './aws/tailscale-key.js';
import { access, type MetroAws } from './aws/access.js';
import { ROLE_ARN_RE } from './aws/sts.js';

export interface LaunchConfig extends MetroAws {
  tailnet: string;
  tailscale: TailscaleClient | null;
}

const TAILNET_RE = /^(?:[a-z0-9-]+\.)*ts\.net$/;
const CLIENT_ID_RE = /^[A-Za-z0-9]{4,100}$/;
const CLIENT_SECRET_RE = /^tskey-client-[A-Za-z0-9_-]{8,200}$/;
const RETIRED_KEY = 'METRO_TAILSCALE_AUTH_KEY';
const KEY_NAMES = ['METRO_AWS_ACCESS_KEY_ID', 'METRO_AWS_SECRET_ACCESS_KEY'];

const read = (env: NodeJS.ProcessEnv, name: string): string => (env[name] ?? '').trim();

export type ConfigResult =
  | { ok: true; config: LaunchConfig }
  | { ok: false; missing: string[] };

function tailscaleClient(env: NodeJS.ProcessEnv): TailscaleClient | null {
  const id = read(env, 'METRO_TAILSCALE_CLIENT_ID');
  const secret = read(env, 'METRO_TAILSCALE_CLIENT_SECRET');
  return CLIENT_ID_RE.test(id) && CLIENT_SECRET_RE.test(secret) ? { id, secret } : null;
}

function keyOf(env: NodeJS.ProcessEnv): { key: AwsKeys | null; missing: string[] } {
  const accessKeyId = read(env, 'METRO_AWS_ACCESS_KEY_ID');
  const secretAccessKey = read(env, 'METRO_AWS_SECRET_ACCESS_KEY');
  if (accessKeyId !== '' && secretAccessKey !== '') return { key: { accessKeyId, secretAccessKey }, missing: [] };
  if (accessKeyId === '' && secretAccessKey === '') return { key: null, missing: [] };
  return { key: null, missing: [accessKeyId === '' ? 'METRO_AWS_ACCESS_KEY_ID' : 'METRO_AWS_SECRET_ACCESS_KEY'] };
}

function roleOf(env: NodeJS.ProcessEnv): { role: string | null; missing: string[] } {
  const role = read(env, 'METRO_AWS_ROLE_ARN');
  if (role === '') return { role: null, missing: [] };
  return ROLE_ARN_RE.test(role) ? { role, missing: [] } : { role: null, missing: ['METRO_AWS_ROLE_ARN'] };
}

export function readLaunchConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const { key, missing: keyMissing } = keyOf(env);
  const { role, missing: roleMissing } = roleOf(env);
  const credentials = key ?? (role === null ? null : access.metroRole(role));
  const tailnet = read(env, 'METRO_LAUNCH_TAILNET').toLowerCase();
  const none = credentials === null && roleMissing.length === 0 ? KEY_NAMES : [];
  const missing = [...new Set([...keyMissing, ...none, ...roleMissing, ...(TAILNET_RE.test(tailnet) ? [] : ['METRO_LAUNCH_TAILNET'])])];
  if (missing.length > 0 || credentials === null) return { ok: false, missing };
  return { ok: true, config: { credentials, role, tailnet, tailscale: tailscaleClient(env) } };
}

function announceIdentity(config: LaunchConfig): void {
  if (typeof config.credentials !== 'function') {
    log.info({ role: config.role }, config.role === null ? 'aws: metro signs in with its access key' : 'aws: metro signs in to its own account with its access key until that key is unset, and to connected accounts with its role');
    return;
  }
  log.info({ role: config.role }, 'aws: metro signs in with its role through Fly, no access key');
}

export function announceLaunchConfig(result: ConfigResult, env: NodeJS.ProcessEnv = process.env): void {
  if (read(env, RETIRED_KEY) !== '')
    log.warn({ unused: RETIRED_KEY }, 'launch: this secret is no longer read; revoke that key in Tailscale and unset it');
  if (!result.ok) {
    log.info({ missing: result.missing }, 'launch: metro issues no servers, these are unset or malformed');
    return;
  }
  announceIdentity(result.config);
  if (result.config.tailscale === null) {
    log.info(
      { missing: ['METRO_TAILSCALE_CLIENT_ID', 'METRO_TAILSCALE_CLIENT_SECRET'] },
      'launch: metro issues no new servers until a Tailscale OAuth client is set; resizes, deletions and charts still work',
    );
    return;
  }
  log.info({ tailnet: result.config.tailnet }, 'launch: metro can issue servers to any signed-in organization, each with its own one-time Tailscale key');
}
