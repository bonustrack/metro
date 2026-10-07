import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE = Bun.which('node') ?? 'node';
const SLOT = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
const PROMPT = 'A private test prompt that must never appear in command output.';
let suite = '';
let root = '';
let env: NodeJS.ProcessEnv;

function snapshot(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).sort().map((name) => {
    const path = join(dir, String(name));
    const stat = lstatSync(path);
    const digest = stat.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : '';
    return `${String(name)} ${String(stat.mode)} ${String(stat.mtimeMs)} ${digest}`;
  });
}

function run(args: string[], changes: NodeJS.ProcessEnv = {}) {
  return spawnSync(NODE, [join(suite, 'dist', 'cli.js'), 'task', ...args], {
    cwd: root,
    env: { ...env, ...changes },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function result(args: string[]): Record<string, unknown> {
  const child = run(args);
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stderr).toBe('');
  expect(child.stdout.trim().split('\n')).toHaveLength(1);
  expect(child.stdout).not.toContain(PROMPT);
  return JSON.parse(child.stdout) as Record<string, unknown>;
}

beforeAll(() => {
  suite = mkdtempSync(join(tmpdir(), 'metro-task-staged-suite-'));
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const buildEnv = { PATH: process.env.PATH, HOME: suite, TMPDIR: suite };
  const built = spawnSync(NODE, [tsc, '--project', join(CLI, 'tsconfig.json'), '--outDir', join(suite, 'dist')], { env: buildEnv, encoding: 'utf8' });
  expect(`${built.stdout}${built.stderr}`).toBe('');
  expect(built.status).toBe(0);
  writeFileSync(join(suite, 'package.json'), '{"type":"module"}\n');
  const staged = spawnSync(NODE, [join(CLI, 'scripts', 'stage-runtime.mjs')], { env: buildEnv, encoding: 'utf8' });
  expect(staged.status).toBe(0);
  expect(staged.stderr).toBe('');
}, 30_000);

afterAll(() => { rmSync(suite, { recursive: true, force: true }); });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metro-task-staged-'));
  const runtime = join(root, 'runtime');
  mkdirSync(runtime);
  cpSync(join(CLI, 'runtime', 'sdk-runner'), join(runtime, 'sdk-runner'), { recursive: true });
  writeFileSync(join(runtime, 'server.ts'), 'throw new Error("The daemon must not start");\n');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const bun = join(bin, 'bun');
  writeFileSync(bun, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TASK_TEST_CALLS"\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  chmodSync(bun, 0o700);
  env = { PATH: bin, HOME: join(root, 'home'), TMPDIR: root, METRO_RUNTIME_DIR: runtime, TASK_TEST_CALLS: join(root, 'calls') };
  for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR', 'METRO_STATE_DIR', 'METRO_AGENTS_DIR', 'METRO_RUNNER_STORE', 'METRO_RUNTIME_STORE']) {
    const dir = env[name] ?? join(root, name);
    env[name] = dir;
    mkdirSync(dir);
  }
  env.METRO_RUNNER_STATE = join(root, 'state', 'agent-session.json');
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'prompt.txt'), PROMPT);
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test('the real staged command durably submits offline and deduplicates without preparing a runtime or starting a session', () => {
  const runtimeBefore = snapshot(join(root, 'runtime'));
  const args = ['submit', 'hourly', join(root, 'prompt.txt'), '--slot', SLOT];
  const accepted = result(args);
  expect(accepted).toMatchObject({ status: 'accepted', queued: true, version: 1, routine: 'hourly', slot: Date.parse(SLOT) });
  expect(result(args)).toEqual(accepted);
  const status = result(['status']);
  expect(status.tasks).toEqual([{ version: 1, uuid: accepted.uuid, routine: 'hourly', slot: Date.parse(SLOT), createdAt: accepted.createdAt, state: 'pending', token: null, updatedAt: null }]);
  expect(snapshot(join(root, 'runtime'))).toEqual(runtimeBefore);
  expect(existsSync(env.METRO_RUNNER_STATE ?? '')).toBe(false);
  for (const name of ['HOME', 'METRO_AGENTS_DIR', 'METRO_RUNNER_STORE', 'METRO_RUNTIME_STORE', 'CLAUDE_CONFIG_DIR']) expect(snapshot(env[name] ?? '')).toEqual([]);
  const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n');
  expect(calls).toHaveLength(6);
  for (let i = 0; i < calls.length; i += 2) {
    expect(calls[i]).toBe('--version');
    expect(calls[i + 1]).toStartWith(`--no-install ${join(root, 'runtime', 'sdk-runner', 'src', 'automation-cli.ts')} `);
  }
  expect(existsSync(join(root, 'runtime', 'sdk-runner', 'node_modules', '@anthropic-ai'))).toBe(false);
});

test('real staged dry-run and empty status create no directories, lock, state or runtime changes', () => {
  const paths = ['home', 'state', 'runtime', 'METRO_RUNNER_STORE', 'METRO_RUNTIME_STORE', 'METRO_AGENTS_DIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR'];
  const before = paths.map((path) => snapshot(join(root, path)));
  expect(result(['submit', 'hourly', join(root, 'prompt.txt'), '--dry-run'])).toMatchObject({ status: 'validated', dryRun: true, queued: false });
  expect(result(['status'])).toEqual({ tasks: [] });
  expect(paths.map((path) => snapshot(join(root, path)))).toEqual(before);
});

test('dry-run and status do not create a Bun cache in an empty HOME without XDG overrides', () => {
  for (const name of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) delete env[name];
  expect(result(['submit', 'empty-home-check', join(root, 'prompt.txt'), '--dry-run'])).toMatchObject({ queued: false, dryRun: true });
  expect(result(['status'])).toEqual({ tasks: [] });
  expect(snapshot(env.HOME ?? '')).toEqual([]);
  expect(snapshot(join(root, 'state'))).toEqual([]);
});

test('HOME fallback creates only the offline automation queue beside the future session', () => {
  delete env.METRO_RUNNER_STATE;
  const accepted = result(['submit', 'hourly', join(root, 'prompt.txt'), '--slot', SLOT]);
  expect(accepted.status).toBe('accepted');
  expect(existsSync(join(env.HOME ?? '', '.metro', 'automation'))).toBe(true);
  expect(existsSync(join(env.HOME ?? '', '.metro', 'agent-session.json'))).toBe(false);
});

test('a conflicting duplicate fails without prompt leakage or changing the queued request', () => {
  const args = ['submit', 'hourly', join(root, 'prompt.txt'), '--slot', SLOT];
  const accepted = result(args);
  writeFileSync(join(root, 'prompt.txt'), 'Another secret prompt');
  const child = run(args);
  expect(child.status).toBe(1);
  expect(child.stdout).toBe('');
  expect(child.stderr).toStartWith('metro task: ');
  expect(child.stderr.length).toBeLessThan(300);
  expect(child.stderr).not.toContain('secret');
  expect(JSON.stringify(result(['status']))).toContain(String(accepted.uuid));
});

test('the staged status supplies the token and finish only accepts a receipt for runner verification', () => {
  const accepted = result(['submit', 'offline-check', join(root, 'prompt.txt'), '--slot', SLOT]);
  const token = '11111111-1111-4111-8111-111111111111';
  const source = join(root, 'runtime', 'sdk-runner', 'node_modules', '@metro-labs', 'core', 'src', 'automation-store.ts');
  const seeded = spawnSync(process.execPath, ['--no-install', '-e', `
    import { AutomationStore } from ${JSON.stringify(source)};
    const store = new AutomationStore(${JSON.stringify(join(root, 'state', 'automation'))});
    store.saveStatus({ uuid: ${JSON.stringify(accepted.uuid)}, token: ${JSON.stringify(token)}, state: 'awaiting-completion', updatedAt: Date.now(), detail: 'sdk-completed' });
  `], { cwd: root, env, encoding: 'utf8' });
  expect(seeded.status).toBe(0);
  expect(seeded.stderr).toBe('');
  expect(seeded.stdout).toBe('');
  const status = result(['status']);
  expect(status.tasks).toEqual([expect.objectContaining({ uuid: accepted.uuid, state: 'awaiting-completion', token, detail: 'sdk-completed' })]);
  const receipt = result(['finish', String(accepted.uuid), token, 'completed']);
  expect(receipt).toMatchObject({ status: 'accepted', verification: 'pending', uuid: accepted.uuid, requestedOutcome: 'completed' });
  expect(receipt).not.toHaveProperty('state');
  expect(receipt).not.toHaveProperty('token');
  expect(result(['finish', String(accepted.uuid), token, 'completed'])).toEqual(receipt);
  expect(result(['status'])).toEqual(status);
});

test('invalid arguments and unreadable prompts produce one safe bounded error and no state', () => {
  for (const args of [['invalid-secret-command'], ['submit', 'daily', 'file'], ['submit', 'hourly', join(root, 'private-missing-file')], ['finish', 'secret-uuid', 'secret-token', 'completed']]) {
    const child = run(args);
    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(child.stderr).toStartWith('metro task: ');
    expect(child.stderr.length).toBeLessThan(300);
    expect(child.stderr).not.toContain('secret');
    expect(child.stderr).not.toContain('private-missing-file');
    expect(snapshot(join(root, 'state'))).toEqual([]);
  }
});

test('missing Bun or shipped runtime fails without installing anything', () => {
  rmSync(join(root, 'bin', 'bun'));
  let child = run(['status']);
  expect(child.status).toBe(1);
  expect(child.stdout).toBe('');
  expect(child.stderr).toContain('needs Bun on PATH');
  child = run(['status'], { METRO_RUNTIME_DIR: join(root, 'absent-runtime') });
  expect(child.status).toBe(1);
  expect(child.stderr).toContain('needs the shipped runtime');
  rmSync(join(root, 'runtime', 'sdk-runner', 'src', 'automation-cli.ts'));
  child = run(['status']);
  expect(child.status).toBe(1);
  expect(child.stderr).toContain('missing its shipped entry');
  expect(snapshot(join(root, 'state'))).toEqual([]);
  expect(existsSync(join(root, 'calls'))).toBe(false);
});

test('task help needs neither Bun nor runtime and states the authorization and receipt limits', () => {
  rmSync(join(root, 'bin', 'bun'));
  const child = run(['--help'], { METRO_RUNTIME_DIR: join(root, 'absent-runtime') });
  expect(child.status).toBe(0);
  expect(child.stdout).toBe('');
  expect(child.stderr).toContain('never start a session');
  expect(child.stderr).toContain('not fresh owner approval');
  expect(child.stderr).toContain('pending runner verification');
  expect(existsSync(join(root, 'calls'))).toBe(false);
});
