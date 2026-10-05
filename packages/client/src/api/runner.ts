import type { ClaudeSessionStatus, ClaudeSetup } from './claude-box.js';

const RUNNER_NOTE =
  'Each runner keeps its own saved conversation. First use may start a new one. Chats from one runner are not copied to the other. Voice calls remain separate. To switch, finish active work, press Stop, choose a runner, then press Start. Stop cancels the session and its workers; it does not wait for work to finish.';
const MODEL_LIST = 'The AI your agent thinks with: an ordered list of models, and the connections they run on.';
const MODEL_RESTARTS = `${MODEL_LIST} Changing the first model restarts the agent, which takes a few seconds.`;
const MODEL_LIVE = `${MODEL_LIST} The agent cannot pick another model itself, and changing the first model applies at once, with no restart.`;
const NEEDS_KEY =
  'Agent SDK needs an API key or a ChatGPT sign-in on every model of the Model page, the first one and each fallback: Anthropic with an API key, Amazon Bedrock, OpenRouter, or a signed-in Codex connection (with ChatGPT or with a code). Anthropic does not allow products built on the Agent SDK to use a Claude login.';
const KEYS_ONLY = 'Every model in the list needs an API key or a ChatGPT sign-in. A change to an unallowed model is refused while the Agent SDK is running. When stopped, it stays selected but cannot start until all models are allowed.';
const ON_LOGIN = "The Metro operator allows the Agent SDK on this server's Claude login.";

export const OPERATOR_NOTE =
  'Only the Metro operator sees and changes this. Anthropic asks products built on the Agent SDK to use an API key, so allow the Claude login only on your own servers. If taking it back requires Claude Code, let active work and queued messages finish, then Stop. It switches to Claude Code and stays stopped until Start.';

const ACTIVITY_STALE_MS = 30_000;

export const activityIsStale = (updatedAt: number, now: number): boolean => now - updatedAt > ACTIVITY_STALE_MS || updatedAt > now + ACTIVITY_STALE_MS;

export function sessionNote(status: ClaudeSessionStatus, now: number): string {
  if (status.running) {
    const activity = status.activity;
    if (activity === null || status.runner === 'cli') return status.runner === 'sdk' ? 'Session process running. Waiting for Agent SDK status.' : 'Running.';
    const phase = activity.phase === 'approval' ? 'waiting for approval' : activity.phase;
    if (activityIsStale(activity.updatedAt, now)) return `Session process running. SDK status is stale; last reported ${phase}.`;
    return `Session process running. Agent SDK reports ${phase}.`;
  }
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
