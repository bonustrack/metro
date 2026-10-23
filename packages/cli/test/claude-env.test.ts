import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_VIEW_OFF, agentKey, cacheTtlEnv, claudeSignedIn, credentialEnv, gatewayEnv, keepInSession, pinnedBy, rmPromptEnv, servingDaemon, toolSearchEnv } from '../src/claude-env.ts';

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

  test("Claude Code's gateway hint headers are on, so the gateway can tell a compaction apart, unless the user set them", () => {
    expect(gatewayEnv(base, 'mk_secret', 8420).CLAUDE_CODE_GATEWAY_HINT_HEADERS).toBe('1');
    expect(gatewayEnv({ ...base, CLAUDE_CODE_GATEWAY_HINT_HEADERS: '0' }, 'mk_secret', 8420).CLAUDE_CODE_GATEWAY_HINT_HEADERS).toBe('0');
    expect(gatewayEnv(base, null, 8420).CLAUDE_CODE_GATEWAY_HINT_HEADERS).toBeUndefined();
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

describe('when metro leaves Claude Code alone', () => {
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

describe('MCP tool search', () => {
  test('is switched on for every route, since the gateway does the API part of the search for all of them, unless the user chose a value', () => {
    expect(toolSearchEnv({ HOME: '/h' })).toEqual({ HOME: '/h', ENABLE_TOOL_SEARCH: 'true' });
    const chosen = { ENABLE_TOOL_SEARCH: 'false' };
    expect(toolSearchEnv(chosen)).toBe(chosen);
  });
});

describe('the prompt cache through the gateway', () => {
  test('lasts an hour for the session and its workers, since a stand-in key makes Claude Code pick five minutes, unless the user chose a value', () => {
    expect(cacheTtlEnv({ HOME: '/h' })).toEqual({ HOME: '/h', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' });
    expect(cacheTtlEnv({ CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' });
    const chosen = { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' };
    expect(cacheTtlEnv(chosen)).toBe(chosen);
  });
});

describe("Claude Code's prompt for a shell -c script that runs rm", () => {
  test('is switched off, since bypass mode does not skip it and only the launch environment can, unless the user chose a value', () => {
    expect(rmPromptEnv({ HOME: '/h' })).toEqual({ HOME: '/h', CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT: '1' });
    const chosen = { CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT: '0' };
    expect(rmPromptEnv(chosen)).toBe(chosen);
  });
});

describe('Claude Code background sessions', () => {
  test('are switched off unless the user chose otherwise', () => {
    expect(keepInSession({ HOME: '/h' })).toEqual({ HOME: '/h', [AGENT_VIEW_OFF]: '1' });
    expect(keepInSession({ [AGENT_VIEW_OFF]: '0' })).toEqual({ [AGENT_VIEW_OFF]: '0' });
  });
});

describe('whether Claude Code has a login of its own', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metro-claude-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const binary = (script: string): string => {
    const path = join(dir, 'claude');
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  test('asks the Claude Code it is given, never the one on PATH, with its updater off', () => {
    const signedIn = binary('[ "$DISABLE_AUTOUPDATER" = 1 ] && [ "$*" = "auth status --json" ] && echo \'{"loggedIn":true}\'');
    expect(claudeSignedIn(signedIn, { PATH: '/nowhere' })).toBe(true);
  });

  test('an answer that is not a login, a broken one or a missing binary count as signed out', () => {
    expect(claudeSignedIn(binary('echo \'{"loggedIn":false}\''), {})).toBe(false);
    expect(claudeSignedIn(binary('echo nope'), {})).toBe(false);
    expect(claudeSignedIn(join(dir, 'missing'), {})).toBe(false);
  });
});
