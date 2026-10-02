import type { ClaudeSetup } from './claude-box.js';

const RUNNER_NOTE =
  'Claude Code runs the agent in a terminal session. Agent SDK runs it as one session for chat and calls: the front answers fast and background workers do the work, all on the model you pick on the Model page. Changing this restarts the agent, and switching back to Claude Code continues the same conversation.';
const MODEL_RESTARTS = 'The AI your agent thinks with. Switching restarts the agent, which takes a few seconds.';
const MODEL_LIVE = 'The AI your agent thinks with. The Agent SDK session uses only the model picked here, and a switch applies at once, with no restart.';
const NEEDS_KEY =
  'Agent SDK needs an API key: on the Model page, route to Anthropic with an API key, Amazon Bedrock or OpenRouter. Anthropic does not allow products built on the Agent SDK to use a Claude login.';
const ON_LOGIN = "The Metro operator allows the Agent SDK on this server's Claude login.";

export const OPERATOR_NOTE =
  'Only the Metro operator sees and changes this. Anthropic asks products built on the Agent SDK to use an API key, so allow the Claude login only on your own servers. Taking it back puts the agent on Claude Code.';

export const sdkSelectable = (setup: ClaudeSetup): boolean => setup.runnerAllowed || setup.runner === 'sdk';

export function runnerNote(setup: ClaudeSetup): string {
  if (!setup.runnerAllowed) return `${RUNNER_NOTE} ${NEEDS_KEY}`;
  return setup.sdkOnLogin === true ? `${RUNNER_NOTE} ${ON_LOGIN}` : RUNNER_NOTE;
}

export const modelNote = (setup: ClaudeSetup | undefined): string => (setup?.runner === 'sdk' && setup.runnerAllowed ? MODEL_LIVE : MODEL_RESTARTS);
