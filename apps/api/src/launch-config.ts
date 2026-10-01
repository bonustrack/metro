import { log } from '@metro-labs/core/log';
import type { AwsCredentials } from './aws/ec2.js';
import type { TailscaleClient } from './aws/tailscale-key.js';

export interface LaunchConfig {
  credentials: AwsCredentials;
  tailnet: string;
  tailscale: TailscaleClient | null;
}

const TAILNET_RE = /^(?:[a-z0-9-]+\.)*ts\.net$/;
const CLIENT_ID_RE = /^[A-Za-z0-9]{4,100}$/;
const CLIENT_SECRET_RE = /^tskey-client-[A-Za-z0-9_-]{8,200}$/;
const RETIRED_KEY = 'METRO_TAILSCALE_AUTH_KEY';

const read = (env: NodeJS.ProcessEnv, name: string): string => (env[name] ?? '').trim();

export type ConfigResult =
  | { ok: true; config: LaunchConfig }
  | { ok: false; missing: string[] };

function tailscaleClient(env: NodeJS.ProcessEnv): TailscaleClient | null {
  const id = read(env, 'METRO_TAILSCALE_CLIENT_ID');
  const secret = read(env, 'METRO_TAILSCALE_CLIENT_SECRET');
  return CLIENT_ID_RE.test(id) && CLIENT_SECRET_RE.test(secret) ? { id, secret } : null;
}

export function readLaunchConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const credentials = {
    accessKeyId: read(env, 'METRO_AWS_ACCESS_KEY_ID'),
    secretAccessKey: read(env, 'METRO_AWS_SECRET_ACCESS_KEY'),
  };
  const tailnet = read(env, 'METRO_LAUNCH_TAILNET').toLowerCase();
  const missing = [
    ...(credentials.accessKeyId === '' ? ['METRO_AWS_ACCESS_KEY_ID'] : []),
    ...(credentials.secretAccessKey === '' ? ['METRO_AWS_SECRET_ACCESS_KEY'] : []),
    ...(TAILNET_RE.test(tailnet) ? [] : ['METRO_LAUNCH_TAILNET']),
  ];
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, config: { credentials, tailnet, tailscale: tailscaleClient(env) } };
}

export function announceLaunchConfig(result: ConfigResult, env: NodeJS.ProcessEnv = process.env): void {
  if (read(env, RETIRED_KEY) !== '')
    log.warn({ unused: RETIRED_KEY }, 'launch: this secret is no longer read; revoke that key in Tailscale and unset it');
  if (!result.ok) {
    log.info({ missing: result.missing }, 'launch: metro issues no servers, these are unset or malformed');
    return;
  }
  if (result.config.tailscale === null) {
    log.info(
      { missing: ['METRO_TAILSCALE_CLIENT_ID', 'METRO_TAILSCALE_CLIENT_SECRET'] },
      'launch: metro issues no new servers until a Tailscale OAuth client is set; resizes, deletions and charts still work',
    );
    return;
  }
  log.info({ tailnet: result.config.tailnet }, 'launch: metro can issue servers to any signed-in organization, each with its own one-time Tailscale key');
}
