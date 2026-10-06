import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureSecureDir, writeSecure } from '@metro-labs/core/secure-fs';
import { TrainError } from '@metro-labs/core/train-error';

export interface ManagedBinding {
  managed?: boolean;
  managedOrganization?: string;
  managedHost?: string;
}

const bindingDir = (): string => process.env.METRO_AGENTS_DIR ?? join(homedir(), '.metro', 'agents');

export function setManagedHost(url: string | null): void {
  const dir = bindingDir();
  ensureSecureDir(dir);
  writeSecure(join(dir, '.gmail-host'), url === null ? '' : new URL(url).host);
}

export function checkManagedBinding(config: ManagedBinding): void {
  if (config.managed !== true) return;
  let owner = '';
  let host = '';
  try {
    owner = readFileSync(join(bindingDir(), '.owner'), 'utf8').trim();
    host = readFileSync(join(bindingDir(), '.gmail-host'), 'utf8').trim();
  } catch {
    throw new TrainError('gmail_binding_changed', 'Reconnect managed Gmail on this box before using it.', { retryable: false });
  }
  if (!owner || owner !== config.managedOrganization || !host || host !== config.managedHost)
    throw new TrainError('gmail_binding_changed', 'This box changed owner or address. Reconnect managed Gmail before using it.', { retryable: false });
}
