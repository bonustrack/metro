import { isRecord } from './accounts.js';
import { claudeCall } from './claude.js';

export interface ClaudeSessionStatus {
  name: string;
  running: boolean;
  autostart: boolean;
  blocked: string | null;
  lastStartedAt: string | null;
  lastError: string | null;
}

const optionalText = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

export function toClaudeSession(body: unknown): ClaudeSessionStatus {
  if (!isRecord(body) || typeof body.running !== 'boolean') throw new Error('Metro returned an unexpected response.');
  return {
    name: typeof body.name === 'string' ? body.name : 'metro',
    running: body.running,
    autostart: body.autostart !== false,
    blocked: optionalText(body.blocked),
    lastStartedAt: optionalText(body.lastStartedAt),
    lastError: optionalText(body.lastError),
  };
}

export async function fetchClaudeSession(): Promise<ClaudeSessionStatus> {
  return toClaudeSession(await claudeCall('GET', '/session'));
}

export async function controlClaudeSession(input: { action?: 'start' | 'stop'; autostart?: boolean }): Promise<ClaudeSessionStatus> {
  return toClaudeSession(await claudeCall('POST', '/session', input));
}

export interface ClaudeSetup {
  privacy: boolean;
  worker: boolean;
  skill: boolean;
  privacyApplied: boolean;
  retentionDays: number | null;
}

export function toClaudeSetup(body: unknown): ClaudeSetup {
  if (!isRecord(body) || typeof body.privacy !== 'boolean') throw new Error('Metro returned an unexpected response.');
  return {
    privacy: body.privacy,
    worker: body.worker === true,
    skill: body.skill === true,
    privacyApplied: body.privacyApplied === true,
    retentionDays: typeof body.retentionDays === 'number' ? body.retentionDays : null,
  };
}

export async function fetchClaudeSetup(): Promise<ClaudeSetup> {
  return toClaudeSetup(await claudeCall('GET', '/setup'));
}

export async function setClaudePrivacy(privacy: boolean): Promise<ClaudeSetup> {
  return toClaudeSetup(await claudeCall('POST', '/setup', { privacy }));
}
