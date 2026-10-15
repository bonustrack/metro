import type { ClaudeSessionStatus } from './claude-box.js';

const ACTIVITY_STALE_MS = 30_000;

export const LEGACY_RUNNER_NOTE = 'Running on Claude Code. Update Metro to move it to the Agent SDK.';

export const activityIsStale = (updatedAt: number, now: number): boolean => now - updatedAt > ACTIVITY_STALE_MS || updatedAt > now + ACTIVITY_STALE_MS;

function runningNote(status: ClaudeSessionStatus, now: number): string {
  const activity = status.activity;
  if (status.legacyRunner) return LEGACY_RUNNER_NOTE;
  if (activity === null) return 'Session process running. Waiting for Agent SDK status.';
  const phase = activity.phase === 'approval' ? 'waiting for approval' : activity.phase;
  if (activityIsStale(activity.updatedAt, now)) return `Session process running. SDK status is stale; last reported ${phase}.`;
  return `Session process running. Agent SDK reports ${phase}.`;
}

export function sessionNote(status: ClaudeSessionStatus, now: number): string {
  if (status.running) return runningNote(status, now);
  if (status.lastError !== null) return `Not running: ${status.lastError}`;
  if (status.blocked !== null) return `Waiting: ${status.blocked}.`;
  return status.autostart ? 'Starting in a few seconds.' : 'Not running. Press Start to run the agent.';
}
