import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSession, claudePackage, prepareRunner, readRunnerManifest, runnerDependencies, runnerEnv, runnerStore } from '../src/agent.js';
import { launchClaude } from '../src/claude.js';
import { harnessRunner } from '../src/route.js';

let root = '';
let bun = '';
let calls = '';

function stage(version: string): string {
  const sources = join(root, `sources-${version}`);
  mkdirSync(join(sources, 'src'), { recursive: true });
  writeFileSync(join(sources, 'src', 'main.ts'), `export const v = '${version}';\n`);
  mkdirSync(join(sources, 'node_modules', '@metro-labs', 'core', 'src'), { recursive: true });
  writeFileSync(join(sources, 'node_modules', '@metro-labs', 'core', 'package.json'), '{}');
  writeFileSync(join(sources, 'runner.json'), JSON.stringify({ version, dependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.287', pino: '^9' } }));
  return sources;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metro-cli-agent-'));
  bun = join(root, 'bun');
  calls = join(root, 'calls.log');
  writeFileSync(bun, `#!/bin/sh\necho "$PWD $*" >> ${calls}\nmkdir -p node_modules\n`);
  chmodSync(bun, 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('the runner store gets the staged sources, its SDKs and only the Claude Code binary of this machine at the SDK version, and is reinstalled only on a new version', () => {
  const store = join(root, 'store');
  const quiet = (): undefined => undefined;
  const claude = { name: '@anthropic-ai/claude-agent-sdk-linux-arm64', binary: 'claude' };
  const { entry, claude: binary } = prepareRunner({ sources: stage('1'), store, bun, log: quiet, claude });
  expect(entry).toBe(join(store, 'src', 'main.ts'));
  expect(binary).toBe(join(store, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-arm64', 'claude'));
  expect(readFileSync(entry, 'utf8')).toContain("'1'");
  expect(existsSync(join(store, 'node_modules', '@metro-labs', 'core', 'package.json'))).toBe(true);
  expect(readFileSync(join(store, 'bunfig.toml'), 'utf8')).toContain('optional = false');
  expect(JSON.parse(readFileSync(join(store, 'package.json'), 'utf8')).dependencies).toEqual({
    '@anthropic-ai/claude-agent-sdk': '0.3.287',
    '@anthropic-ai/claude-agent-sdk-linux-arm64': '0.3.287',
    pino: '^9',
  });
  prepareRunner({ sources: stage('1'), store, bun, log: quiet, claude });
  expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
  prepareRunner({ sources: stage('2'), store, bun, log: quiet, claude });
  expect(readFileSync(entry, 'utf8')).toContain("'2'");
});

test('the Claude Code package is the one the SDK itself would pick for this machine', () => {
  expect(claudePackage('linux', 'x64', false)).toEqual({ name: '@anthropic-ai/claude-agent-sdk-linux-x64', binary: 'claude' });
  expect(claudePackage('linux', 'arm64', true)).toEqual({ name: '@anthropic-ai/claude-agent-sdk-linux-arm64-musl', binary: 'claude' });
  expect(claudePackage('darwin', 'arm64', false).name).toBe('@anthropic-ai/claude-agent-sdk-darwin-arm64');
  expect(claudePackage('win32', 'x64', false).binary).toBe('claude.exe');
  expect(claudePackage().name).toStartWith(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`);
  const manifest = { version: '1', dependencies: { pino: '^9' } };
  expect(runnerDependencies(manifest, claudePackage('linux', 'x64', false))).toEqual({ pino: '^9' });
});

test('the runner is told where metro is, its key, the permission mode, the Harness prompt, and a routed model for both front and workers', () => {
  expect(runnerEnv('mk_x', 8420, null, 'bypass', null, '/s/claude')).toEqual({
    METRO_RUNNER_MCP_URL: 'http://127.0.0.1:8420/mcp',
    METRO_RUNNER_CLAUDE: '/s/claude',
    METRO_AGENT_KEY: 'mk_x',
    METRO_RUNNER_PERMISSION_MODE: 'bypass',
  });
  expect(runnerEnv('mk_x', 9000, 'codex:gpt-6', 'auto', 'You are Emma.', '/s/claude')).toEqual(
    expect.objectContaining({ METRO_RUNNER_FRONT_MODEL: 'codex:gpt-6', METRO_RUNNER_WORKER_MODEL: 'codex:gpt-6', METRO_RUNNER_PROMPT: 'You are Emma.' }),
  );
  expect(runnerStore({ METRO_RUNNER_STORE: '/x' })).toBe('/x');
  expect(readRunnerManifest('{"version":"1","dependencies":{"a":"1","b":2}}')).toEqual({ version: '1', dependencies: { a: '1' } });
});

test('metro agent does not start while the Harness runs the agent as a Claude Code session', async () => {
  const agents = join(root, 'agents');
  mkdirSync(agents);
  writeFileSync(join(agents, 'claude-setup.json'), JSON.stringify({ runner: 'cli' }));
  const prior = process.env.METRO_AGENTS_DIR;
  const cwd = process.cwd();
  process.env.METRO_AGENTS_DIR = agents;
  try {
    let refused = '';
    await agentSession().catch((err: unknown) => {
      refused = err instanceof Error ? err.message : String(err);
    });
    expect(refused).toContain('Claude Code session');
  } finally {
    process.chdir(cwd);
    if (prior === undefined) delete process.env.METRO_AGENTS_DIR;
    else process.env.METRO_AGENTS_DIR = prior;
  }
});

test('metro claude refuses to take the chat while the Harness runs the agent on the Agent SDK', async () => {
  const agents = join(root, 'agents');
  mkdirSync(agents);
  expect(harnessRunner(agents)).toBe('cli');
  writeFileSync(join(agents, 'claude-setup.json'), JSON.stringify({ runner: 'sdk' }));
  expect(harnessRunner(agents)).toBe('sdk');
  const prior = process.env.METRO_AGENTS_DIR;
  process.env.METRO_AGENTS_DIR = agents;
  try {
    let refused = '';
    await launchClaude([]).catch((err: unknown) => {
      refused = err instanceof Error ? err.message : String(err);
    });
    expect(refused).toContain('Agent SDK session');
  } finally {
    if (prior === undefined) delete process.env.METRO_AGENTS_DIR;
    else process.env.METRO_AGENTS_DIR = prior;
  }
});
