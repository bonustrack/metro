import { describe, expect, test } from 'bun:test';
import { agentKey, claudeArgs, credentialEnv, gatewayEnv, pinnedBy, servingDaemon } from '../src/claude.ts';

describe('metro claude hands everything to claude untouched', () => {
  test('the channel and permission flags come first, then the user arguments verbatim, so a user flag wins', () => {
    expect(claudeArgs(['-r', 'abc'])).toEqual([
      '--dangerously-load-development-channels',
      'server:metro',
      '--permission-mode',
      'auto',
      '--system-prompt-snapshot',
      'off',
      '-r',
      'abc',
    ]);
  });

  test('unknown, future or odd flags pass through unparsed', () => {
    const odd = ['--dangerously-something-new=yes', '--', '-c', 'a b', '--flag-with=equals'];
    expect(claudeArgs(odd).slice(6)).toEqual(odd);
  });

  test('no arguments means only the channel flag', () => {
    expect(claudeArgs([])).toEqual([
      '--dangerously-load-development-channels',
      'server:metro',
      '--permission-mode',
      'auto',
      '--system-prompt-snapshot',
      'off',
    ]);
  });

  test('the system prompt from the Harness page is appended before the user arguments, and none means no flag', () => {
    expect(claudeArgs(['-c'], undefined, 'auto', 'You are Lisa.\nBe brief.').slice(6)).toEqual(['--append-system-prompt', 'You are Lisa.\nBe brief.', '-c']);
    expect(claudeArgs(['-c'], '/tmp/mcp.json', 'auto', null).slice(6)).toEqual(['--mcp-config', '/tmp/mcp.json', '-c']);
  });

  test('the permission mode the box chose is passed, bypass as bypassPermissions', () => {
    expect(claudeArgs([], undefined, 'bypass').slice(2, 4)).toEqual(['--permission-mode', 'bypassPermissions']);
    expect(claudeArgs([], undefined, 'auto').slice(2, 4)).toEqual(['--permission-mode', 'auto']);
  });

  test('the metro MCP server rides along as an --mcp-config file, before the user arguments', () => {
    expect(claudeArgs(['-r', 'abc'], '/tmp/metro-claude-x/mcp.json')).toEqual([
      '--dangerously-load-development-channels',
      'server:metro',
      '--permission-mode',
      'auto',
      '--system-prompt-snapshot',
      'off',
      '--mcp-config',
      '/tmp/metro-claude-x/mcp.json',
      '-r',
      'abc',
    ]);
  });
});

describe('inference goes through the daemon gateway', () => {
  const base = { PATH: '/usr/bin', HOME: '/home/less' };

  test('with a running daemon and an agent key, Claude Code is pointed at the gateway and authenticates with the key', () => {
    const env = gatewayEnv(base, 'mk_secret', 8420);
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8420/gateway');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('x-metro-key: mk_secret');
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe('1');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  test('an existing custom header line is kept in front of ours', () => {
    const env = gatewayEnv({ ...base, ANTHROPIC_CUSTOM_HEADERS: 'x-team: a' }, 'mk_secret', 8420);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('x-team: a\nx-metro-key: mk_secret');
  });

  test('no key means no gateway, and a base url or provider flag the user set wins', () => {
    expect(gatewayEnv(base, null, 8420)).toEqual(base);
    const pinned = { ...base, ANTHROPIC_BASE_URL: 'https://gateway.example' };
    expect(gatewayEnv(pinned, 'mk_secret', 8420)).toEqual(pinned);
    const bedrock = { ...base, CLAUDE_CODE_USE_BEDROCK: '1' };
    expect(gatewayEnv(bedrock, 'mk_secret', 8420)).toEqual(bedrock);
  });
});

describe('when metro claude leaves Claude Code alone', () => {
  test('a base url or provider flag in the environment pins Claude Code, and is named', () => {
    expect(pinnedBy({})).toBeNull();
    expect(pinnedBy({ ANTHROPIC_BASE_URL: 'https://gw' })).toBe('ANTHROPIC_BASE_URL');
    expect(pinnedBy({ CLAUDE_CODE_USE_VERTEX: '1' })).toBe('CLAUDE_CODE_USE_VERTEX');
    expect(pinnedBy({ CLAUDE_CODE_USE_BEDROCK: '  ' })).toBeNull();
  });

  test('a parked daemon does not count as serving', () => {
    expect(servingDaemon({ mode: 'local', owner: '0xabc' })).toBe(true);
    expect(servingDaemon({ mode: 'local', stopped: true })).toBe(false);
    expect(servingDaemon({ mode: 'hosted' })).toBe(false);
    expect(servingDaemon(null)).toBe(false);
  });

  test('no agent says so, and the one agent file gives its key', () => {
    expect(agentKey(null)).toEqual({ skip: expect.stringContaining('no agent lives') as unknown as string });
    expect(agentKey({ id: 'agent000001', key: 'mk_t' })).toEqual({ key: 'mk_t' });
  });
});

describe('a box with no Anthropic account at all', () => {
  const routed = { PATH: '/bin', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8420/gateway' };

  test("without a login or a key of its own, Claude Code gets metro's key as its credential", () => {
    expect(credentialEnv(routed, 'mk_agent', false)).toEqual({ ...routed, ANTHROPIC_AUTH_TOKEN: 'mk_agent' });
  });

  test('a claude.ai login, an API key or an auth token the user set are left alone', () => {
    expect(credentialEnv(routed, 'mk_agent', true)).toBe(routed);
    const withKey = { ...routed, ANTHROPIC_API_KEY: 'sk-ant-client' };
    expect(credentialEnv(withKey, 'mk_agent', false)).toBe(withKey);
    const withToken = { ...routed, ANTHROPIC_AUTH_TOKEN: 'their-gateway' };
    expect(credentialEnv(withToken, 'mk_agent', false)).toBe(withToken);
  });
});
