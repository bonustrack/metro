import { join } from 'node:path';
import { agentsDir } from '../agents/files.js';

export const PROXY_VERSION = '0.50.0';

const basePort = (): number => {
  const raw = Number(process.env.METRO_VAULT_PORT);
  return Number.isInteger(raw) && raw > 1024 && raw < 65000 ? raw : 8421;
};

export const ports = (): { tunnel: number; http: number; https: number; management: number; metrics: number } => {
  const base = basePort();
  return { tunnel: base, http: base + 1, https: base + 2, management: base + 3, metrics: base + 4 };
};

export const vaultDir = (dir = agentsDir()): string => join(dir, 'vault');
export const stateFile = (dir = vaultDir()): string => join(dir, 'vault.json');
export const valuesDir = (dir = vaultDir()): string => join(dir, 'values');
export const valueFile = (id: string, dir = vaultDir()): string => join(valuesDir(dir), id);
export const caDir = (dir = vaultDir()): string => join(dir, 'ca');
export const binDir = (dir = vaultDir()): string => join(dir, 'bin');
export const proxyBin = (dir = vaultDir()): string => join(binDir(dir), `iron-proxy-${PROXY_VERSION}`);
export const configFile = (dir = vaultDir()): string => join(dir, 'iron-proxy.json');

export const TRUSTED_CA = '/usr/local/share/ca-certificates/metro-vault.crt';
export const SYSTEM_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
