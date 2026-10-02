import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';
import { readJson, writeJson } from '@metro-labs/core/secure-fs';

const STATE_FILE = 'claude-setup.json';

const statePath = (agents: string): string => join(agents, STATE_FILE);

export function readSetupState(agents: string): Record<string, unknown> {
  const raw = readJson<unknown>(statePath(agents), null);
  return isRecord(raw) ? raw : {};
}

export function writeSetupState(agents: string, patch: Record<string, unknown>): void {
  mkdirSync(agents, { recursive: true });
  writeJson(statePath(agents), { ...readSetupState(agents), ...patch });
}
