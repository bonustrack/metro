export const START_COMMAND =
  'claude --dangerously-load-development-channels server:metro';

export const RESUME_COMMAND =
  'claude -c --dangerously-load-development-channels server:metro';

export const KEY_PLACEHOLDER = '<your agent key>';

const DEFAULT_ENDPOINT = 'https://mcp.metro.box/mcp';

export function registerCommand(endpoint: string): string {
  const url = endpoint === '' ? DEFAULT_ENDPOINT : endpoint;
  return `claude mcp add --transport http metro "${url}?token=${KEY_PLACEHOLDER}"`;
}
