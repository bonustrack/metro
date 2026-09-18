import { isOrganizationId } from '@metro-labs/http/workos-token';
import { log } from '@metro-labs/core/log';
import { AUTH_KEY_RE } from './aws/user-data.js';
import type { AwsCredentials } from './aws/ec2.js';

export interface LaunchConfig {
  credentials: AwsCredentials;
  tailnet: string;
  authKey: string;
  owners: readonly string[];
}

const TAILNET_RE = /^(?:[a-z0-9-]+\.)*ts\.net$/;

const read = (env: NodeJS.ProcessEnv, name: string): string => (env[name] ?? '').trim();

export function launchOwners(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(',')) {
    const owner = piece.trim();
    if (isOrganizationId(owner) && !out.includes(owner)) out.push(owner);
  }
  return out;
}

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
  const owners = launchOwners(read(env, 'METRO_LAUNCH_OWNERS'));
  const missing = [
    ...(credentials.accessKeyId === '' ? ['METRO_AWS_ACCESS_KEY_ID'] : []),
    ...(credentials.secretAccessKey === '' ? ['METRO_AWS_SECRET_ACCESS_KEY'] : []),
    ...(TAILNET_RE.test(tailnet) ? [] : ['METRO_LAUNCH_TAILNET']),
    ...(AUTH_KEY_RE.test(authKey) ? [] : ['METRO_TAILSCALE_AUTH_KEY']),
    ...(owners.length === 0 ? ['METRO_LAUNCH_OWNERS'] : []),
  ];
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    config: { credentials, tailnet, authKey, owners },
  };
}

export const mayLaunch = (config: LaunchConfig, subject: string): boolean => config.owners.includes(subject);

export function announceLaunchConfig(result: ConfigResult): void {
  if (result.ok) {
    log.info(
      { tailnet: result.config.tailnet, owners: result.config.owners.length },
      'launch: metro can issue servers',
    );
    return;
  }
  log.info({ missing: result.missing }, 'launch: metro issues no servers, these are unset or malformed');
}
