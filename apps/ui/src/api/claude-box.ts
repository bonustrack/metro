import { filled, isRecord } from './read.js';
import { claudeCall } from './claude.js';

export interface ClaudeSessionStatus {
  name: string;
  running: boolean;
  autostart: boolean;
  blocked: string | null;
  lastStartedAt: string | null;
  lastError: string | null;
}


function toClaudeSession(body: unknown): ClaudeSessionStatus {
  if (!isRecord(body) || typeof body.running !== 'boolean') throw new Error('Metro returned an unexpected response.');
  return {
    name: typeof body.name === 'string' ? body.name : 'metro',
    running: body.running,
    autostart: body.autostart !== false,
    blocked: filled(body.blocked),
    lastStartedAt: filled(body.lastStartedAt),
    lastError: filled(body.lastError),
  };
}

export async function fetchClaudeSession(): Promise<ClaudeSessionStatus> {
  return toClaudeSession(await claudeCall('GET', '/session'));
}

export async function controlClaudeSession(input: { action?: 'start' | 'stop'; autostart?: boolean }): Promise<ClaudeSessionStatus> {
  return toClaudeSession(await claudeCall('POST', '/session', input));
}

export type PermissionMode = 'auto' | 'bypass';

export interface ClaudeSetup {
  privacy: boolean;
  permissionMode: PermissionMode;
  systemPrompt: string;
  worker: boolean;
  skill: boolean;
  privacyApplied: boolean;
  retentionDays: number | null;
}

function toClaudeSetup(body: unknown): ClaudeSetup {
  if (!isRecord(body) || typeof body.privacy !== 'boolean') throw new Error('Metro returned an unexpected response.');
  return {
    privacy: body.privacy,
    permissionMode: body.permissionMode === 'bypass' ? 'bypass' : 'auto',
    systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : '',
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

export async function setClaudePermissionMode(permissionMode: PermissionMode): Promise<ClaudeSetup> {
  return toClaudeSetup(await claudeCall('POST', '/setup', { permissionMode }));
}

export async function setClaudeSystemPrompt(systemPrompt: string): Promise<ClaudeSetup> {
  return toClaudeSetup(await claudeCall('POST', '/setup', { systemPrompt }));
}

export interface ClaudeVersion {
  installed: string | null;
  latest: string | null;
  newer: boolean;
}

function toClaudeVersion(body: unknown): ClaudeVersion {
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  return { installed: filled(body.installed), latest: filled(body.latest), newer: body.newer === true };
}

export async function fetchClaudeVersion(): Promise<ClaudeVersion> {
  return toClaudeVersion(await claudeCall('GET', '/version'));
}

export async function updateClaudeCode(): Promise<ClaudeVersion & { restarted: boolean }> {
  const body = await claudeCall('POST', '/version');
  return { ...toClaudeVersion(body), restarted: isRecord(body) && body.restarted === true };
}
