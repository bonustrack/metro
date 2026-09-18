import { log } from '@metro-labs/core/log';
import { AUTH_KEY_RE } from './aws/user-data.js';
import type { AwsCredentials } from './aws/ec2.js';

export interface LaunchConfig {
  credentials: AwsCredentials;
  tailnet: string;
  authKey: string;
}

const TAILNET_RE = /^(?:[a-z0-9-]+\.)*ts\.net$/;

const read = (env: NodeJS.ProcessEnv, name: string): string => (env[name] ?? '').trim();

export type ConfigResult =
  | { ok: true; config: LaunchConfig }
  | { ok: false; missing: string[] };

export function readLaunchConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const credentials = {
    accessKeyId: read(env, 'METRO_AWS_ACCESS_KEY_ID'),
    secretAccessKey: read(env, 'METRO_AWS_SECRET_ACCESS_KEY'),
  };
  const tailnet = read(env, 'METRO_LAUNCH_TAILNET').toLowerCase();
  const authKey = read(env, 'METRO_TAILSCALE_AUTH_KEY');
  const missing = [
    ...(credentials.accessKeyId === '' ? ['METRO_AWS_ACCESS_KEY_ID'] : []),
    ...(credentials.secretAccessKey === '' ? ['METRO_AWS_SECRET_ACCESS_KEY'] : []),
    ...(TAILNET_RE.test(tailnet) ? [] : ['METRO_LAUNCH_TAILNET']),
    ...(AUTH_KEY_RE.test(authKey) ? [] : ['METRO_TAILSCALE_AUTH_KEY']),
  ];
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    config: { credentials, tailnet, authKey },
  };
}

export function announceLaunchConfig(result: ConfigResult): void {
  if (result.ok) {
    log.info(
      { tailnet: result.config.tailnet },
      'launch: metro can issue servers to any signed-in organization',
    );
    return;
  }
  log.info({ missing: result.missing }, 'launch: metro issues no servers, these are unset or malformed');
}
