import { expect, test } from 'bun:test';
import { voiceArgs, voiceEnv } from '../src/voice.ts';

test('a voice call session gets the chat agent setup: plugin, connectors, metro tools and its approvals', () => {
  const args = voiceArgs('claude-sonnet-5-5', 'bypass', 'You are Emma.', '/tmp/x/mcp.json');
  expect(args).not.toContain('--strict-mcp-config');
  expect(args.join(' ')).not.toContain('enabledPlugins');
  expect(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 2)).toEqual(['--mcp-config', '/tmp/x/mcp.json']);
  expect(args.slice(args.indexOf('--permission-prompt-tool'), args.indexOf('--permission-prompt-tool') + 2)).toEqual(['--permission-prompt-tool', 'stdio']);
  expect(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'bypassPermissions']);
  expect(args).toContain('--no-session-persistence');
  const prompt = args[args.indexOf('--append-system-prompt') + 1] ?? '';
  expect(prompt.startsWith('You are Emma.\n\n')).toBe(true);
  expect(prompt).toContain('Do not post in any chat during the call');
  expect(voiceArgs('m', 'auto', null)).not.toContain('--mcp-config');
  expect(voiceEnv({ HOME: '/h' })).toEqual({ HOME: '/h', METRO_SESSION: 'voice', CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '0' });
  expect(voiceEnv({ CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '500' }).CLAUDE_CODE_MCP_STARTUP_WAIT_MS).toBe('500');
});
