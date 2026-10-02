import { filled, isRecord } from '../read.js';
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
export type HarnessRunner = 'cli' | 'sdk';

export interface MemoryJob {
  state: 'scheduled' | 'own' | 'off' | 'unavailable';
  job: string | null;
}

export interface ClaudeSetup {
  privacy: boolean;
  permissionMode: PermissionMode;
  runner: HarnessRunner | null;
  systemPrompt: string;
  liveEvents: boolean | null;
  memoryRoutine: boolean | null;
  memoryJob: MemoryJob | null;
  worker: boolean;
  skill: boolean;
  stage: boolean;
  memory: boolean;
  privacyApplied: boolean;
  retentionDays: number | null;
}

const JOB_STATES: readonly MemoryJob['state'][] = ['scheduled', 'own', 'off', 'unavailable'];

function toMemoryJob(raw: unknown): MemoryJob | null {
  if (!isRecord(raw)) return null;
  const state = JOB_STATES.find((s) => s === raw.state);
  return state === undefined ? null : { state, job: filled(raw.job) };
}

function toClaudeSetup(body: unknown): ClaudeSetup {
  if (!isRecord(body) || typeof body.privacy !== 'boolean') throw new Error('Metro returned an unexpected response.');
  return {
    privacy: body.privacy,
    permissionMode: body.permissionMode === 'bypass' ? 'bypass' : 'auto',
    runner: body.runner === 'sdk' || body.runner === 'cli' ? body.runner : null,
    systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : '',
    liveEvents: typeof body.liveEvents === 'boolean' ? body.liveEvents : null,
    memoryRoutine: typeof body.memoryRoutine === 'boolean' ? body.memoryRoutine : null,
    memoryJob: toMemoryJob(body.memoryJob),
    worker: body.worker === true,
    skill: body.skill === true,
    stage: body.stage !== false,
    memory: body.memory !== false,
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

export async function setHarnessRunner(runner: HarnessRunner): Promise<ClaudeSetup> {
  return toClaudeSetup(await claudeCall('POST', '/setup', { runner }));
}

export async function setClaudeLiveEvents(liveEvents: boolean): Promise<ClaudeSetup> {
  return toClaudeSetup(await claudeCall('POST', '/setup', { liveEvents }));
}

export async function setClaudeMemoryRoutine(memoryRoutine: boolean): Promise<ClaudeSetup> {
  return toClaudeSetup(await claudeCall('POST', '/setup', { memoryRoutine }));
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
