import type { ClaudeSetup } from './claude-box.js';

const RUNNER_NOTE =
  'Claude Code runs the agent in a terminal session. Agent SDK runs it as one session for chat and calls: a light front answers fast and background workers do the work. Changing this restarts the agent, and switching back to Claude Code continues the same conversation.';
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
