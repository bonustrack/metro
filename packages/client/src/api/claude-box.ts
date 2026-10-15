import { parseRunnerActivity, type RunnerActivity } from '@metro-labs/core/runner-activity';
import { filled, isRecord } from '../read.js';
import { claudeCall } from './claude.js';

export interface ClaudeSessionStatus {
  name: string;
  running: boolean;
  legacyRunner: boolean;
  autostart: boolean;
  blocked: string | null;
  lastStartedAt: string | null;
  lastError: string | null;
  activity: RunnerActivity | null;
}

export function toClaudeSession(body: unknown): ClaudeSessionStatus {
  if (!isRecord(body) || typeof body.running !== 'boolean') throw new Error('Metro returned an unexpected response.');
  return {
    name: typeof body.name === 'string' ? body.name : 'metro',
    running: body.running,
    legacyRunner: body.runner === 'cli',
    autostart: body.autostart !== false,
    blocked: filled(body.blocked),
    lastStartedAt: filled(body.lastStartedAt),
    lastError: filled(body.lastError),
    activity: parseRunnerActivity(body.activity),
  };
}

export type RuntimeSnapshot = Pick<ClaudeSessionStatus, 'running' | 'legacyRunner' | 'activity' | 'lastStartedAt'>;

export function toRuntimeSnapshot(body: unknown): RuntimeSnapshot {
  const { running, legacyRunner, activity, lastStartedAt } = toClaudeSession(body);
  return { running, legacyRunner: running && legacyRunner, activity, lastStartedAt };
}

export async function fetchClaudeSession(): Promise<ClaudeSessionStatus> {
  return toClaudeSession(await claudeCall('GET', '/session'));
}

export async function controlClaudeSession(input: { action?: 'start' | 'stop'; autostart?: boolean }): Promise<ClaudeSessionStatus> {
  const body = input.action === undefined ? input : { ...input, autostart: input.action === 'start' };
  return toClaudeSession(await claudeCall('POST', '/session', body));
}

export type PermissionMode = 'auto' | 'bypass';

export interface MemoryJob {
  state: 'scheduled' | 'own' | 'off' | 'unavailable';
  job: string | null;
}

export interface ClaudeSetup {
  privacy: boolean;
  permissionMode: PermissionMode;
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

export function toClaudeSetup(body: unknown): ClaudeSetup {
  if (!isRecord(body) || typeof body.privacy !== 'boolean') throw new Error('Metro returned an unexpected response.');
  return {
    privacy: body.privacy,
    permissionMode: body.permissionMode === 'bypass' ? 'bypass' : 'auto',
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

export async function setClaudeLiveEvents(liveEvents: boolean): Promise<ClaudeSetup> {
  return toClaudeSetup(await claudeCall('POST', '/setup', { liveEvents }));
}

export async function setClaudeMemoryRoutine(memoryRoutine: boolean): Promise<ClaudeSetup> {
  return toClaudeSetup(await claudeCall('POST', '/setup', { memoryRoutine }));
}

export async function setClaudeSystemPrompt(systemPrompt: string): Promise<ClaudeSetup> {
  return toClaudeSetup(await claudeCall('POST', '/setup', { systemPrompt }));
}
