import type { ClaudeSessionStatus, ClaudeSetup } from './claude-box.js';

const RUNNER_NOTE =
  'Each runner keeps its own saved conversation. Chats from one runner are not copied to the other. Voice calls remain separate. To switch, let work finish, press Stop, pick a runner, then Start. Stop cancels work at once.';
const MODEL_LIST = 'The models your agent uses, in order, and the connections they run on.';
const MODEL_RESTARTS = `${MODEL_LIST} Changing the first one restarts the agent for a few seconds.`;
const MODEL_LIVE = `${MODEL_LIST} The agent cannot pick another model, and changing the first one applies at once, with no restart.`;
const NEEDS_KEY =
  'Agent SDK needs an API key or a ChatGPT sign-in on the first model and each fallback: Anthropic with an API key, Amazon Bedrock, OpenRouter, or a signed-in Codex connection (with ChatGPT or with a code). Anthropic does not allow a Claude login here.';
const KEYS_ONLY = 'Every model in the list needs an API key or a ChatGPT sign-in. Other models are refused while the Agent SDK is running. When stopped, it stays selected but cannot start.';
const ON_LOGIN = "The Metro operator allows the Agent SDK on this server's Claude login.";

export const OPERATOR_NOTE =
  'Only the Metro operator sees this. Anthropic asks Agent SDK products to use an API key, so allow it only on your own servers. Taking it back moves the agent to Claude Code: let active work and queued messages finish, then Stop. It stays stopped until Start.';

const ACTIVITY_STALE_MS = 30_000;

export const activityIsStale = (updatedAt: number, now: number): boolean => now - updatedAt > ACTIVITY_STALE_MS || updatedAt > now + ACTIVITY_STALE_MS;

function runningNote(status: ClaudeSessionStatus, now: number): string {
  const activity = status.activity;
  if (status.runner === 'cli' && status.channelsSkipped !== null)
    return `Running, but Claude Code refused the Metro channel (${status.channelsSkipped}), so chat messages do not reach the agent.`;
  if (activity === null || status.runner === 'cli') return status.runner === 'sdk' ? 'Session process running. Waiting for Agent SDK status.' : 'Running.';
  const phase = activity.phase === 'approval' ? 'waiting for approval' : activity.phase;
  if (activityIsStale(activity.updatedAt, now)) return `Session process running. SDK status is stale; last reported ${phase}.`;
  return `Session process running. Agent SDK reports ${phase}.`;
}

export function sessionNote(status: ClaudeSessionStatus, now: number): string {
  if (status.running) return runningNote(status, now);
  if (status.lastError !== null) return `Not running: ${status.lastError}`;
  if (status.blocked !== null) return `Waiting: ${status.blocked}.`;
  return status.autostart ? 'Starting in a few seconds.' : 'Not running. Press Start to run the selected runner.';
}

export const sdkSelectable = (setup: ClaudeSetup): boolean => setup.runnerAllowed || setup.runner === 'sdk';

export function runnerNote(setup: ClaudeSetup): string {
  if (!setup.runnerAllowed) return `${RUNNER_NOTE} ${NEEDS_KEY}`;
  return setup.sdkOnLogin === true ? `${RUNNER_NOTE} ${ON_LOGIN}` : RUNNER_NOTE;
}

export function modelNote(setup: ClaudeSetup | undefined): string {
  if (setup?.runner !== 'sdk') return MODEL_RESTARTS;
  if (!setup.runnerAllowed) return `${MODEL_LIST} Agent SDK is selected but blocked. ${KEYS_ONLY}`;
  return setup.sdkOnLogin === true ? MODEL_LIVE : `${MODEL_LIVE} ${KEYS_ONLY}`;
}
