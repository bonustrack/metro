import type { ClaudeSetup } from './claude-box.js';

const RUNNER_NOTE =
  'Claude Code runs the agent in a terminal session. Agent SDK runs it as one session for chat and calls: the front answers fast and background workers do the work, all on the model you pick on the Model page. Changing this restarts the agent, and switching back to Claude Code continues the same conversation.';
const MODEL_LIST = 'The AI your agent thinks with: an ordered list of models, and the connections they run on.';
const MODEL_RESTARTS = `${MODEL_LIST} Changing the first model restarts the agent, which takes a few seconds.`;
const MODEL_LIVE = `${MODEL_LIST} The agent cannot pick another model itself, and changing the first model applies at once, with no restart.`;
const NEEDS_KEY =
  'Agent SDK needs an API key on every model of the Model page, the first one and each fallback: Anthropic with an API key, Amazon Bedrock or OpenRouter. Anthropic does not allow products built on the Agent SDK to use a Claude login.';
const KEYS_ONLY = 'Every model in the list needs an API key, or the agent goes back to Claude Code.';
const ON_LOGIN = "The Metro operator allows the Agent SDK on this server's Claude login.";

export const OPERATOR_NOTE =
  'Only the Metro operator sees and changes this. Anthropic asks products built on the Agent SDK to use an API key, so allow the Claude login only on your own servers. Taking it back puts the agent on Claude Code.';

export const sdkSelectable = (setup: ClaudeSetup): boolean => setup.runnerAllowed || setup.runner === 'sdk';

export function runnerNote(setup: ClaudeSetup): string {
  if (!setup.runnerAllowed) return `${RUNNER_NOTE} ${NEEDS_KEY}`;
  return setup.sdkOnLogin === true ? `${RUNNER_NOTE} ${ON_LOGIN}` : RUNNER_NOTE;
}

export function modelNote(setup: ClaudeSetup | undefined): string {
  if (setup?.runner !== 'sdk' || !setup.runnerAllowed) return MODEL_RESTARTS;
  return setup.sdkOnLogin === true ? MODEL_LIVE : `${MODEL_LIVE} ${KEYS_ONLY}`;
}
