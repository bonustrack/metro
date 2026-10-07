import { afterEach, beforeEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AutomationStore } from '@metro-labs/core/automation-store';
import { automationRequest, AUTOMATION_PROMPT_MAX } from '@metro-labs/core/automation-types';
import { automationCommandFailure, automationRoot, automationShellCommand, readAutomationPrompt, runAutomationCommand } from '../src/automation-command.js';

const NOW = Date.parse('2026-10-06T15:42:03.123Z');
let root = '';
let promptPath = '';
let store: AutomationStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metro-task-command-'));
  promptPath = join(root, 'prompt.txt');
  writeFileSync(promptPath, 'Private routine prompt, never printed.');
  store = new AutomationStore(join(root, 'automation'), () => NOW);
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const deps = () => ({ store, now: () => NOW });

test('automation lives beside the runner ledger, using the same HOME fallback without reading it', () => {
  expect(automationRoot({ HOME: '/fixture/home' })).toBe('/fixture/home/.metro/automation');
  expect(automationRoot({ HOME: '/fixture/home', METRO_RUNNER_STATE: '/fixture/state/session.json' })).toBe('/fixture/state/automation');
  expect(automationRoot({ HOME: ' /fixture/home ', METRO_RUNNER_STATE: ' ' })).toBe('/fixture/home/.metro/automation');
  expect(automationRoot({ HOME: ' /fixture/home ', METRO_RUNNER_STATE: ' /fixture/state/session.json ' })).toBe('/fixture/state/automation');
});

test('hourly submission floors the UTC slot and retries return the first durable request without printing the prompt', async () => {
  const accepted = await runAutomationCommand(['submit', 'hourly', promptPath], deps());
  const request = automationRequest('hourly', Date.parse('2026-10-06T15:00:00Z'), readAutomationPrompt(promptPath), NOW);
  expect(accepted).toEqual({ status: 'accepted', queued: true, state: 'pending', version: 1, routine: 'hourly', slot: request.slot, uuid: request.uuid, createdAt: NOW });
  expect(await runAutomationCommand(['submit', 'hourly', promptPath], deps())).toEqual(accepted);
  expect(store.requests()).toHaveLength(1);
  expect(JSON.stringify(accepted)).not.toContain('Private routine prompt');
  expect(JSON.stringify(accepted)).not.toContain('digest');
});

test('resubmitting a completed request reports its state rather than claiming to queue new work', async () => {
  const args = ['submit', 'hourly', promptPath];
  await runAutomationCommand(args, deps());
  const request = store.requests()[0];
  if (request === undefined) throw new Error('missing submitted request');
  store.saveStatus({ uuid: request.uuid, state: 'completed', token: randomUUID(), updatedAt: NOW, detail: 'worker-completed' });
  expect(await runAutomationCommand(args, deps())).toEqual({ status: 'accepted', queued: false, state: 'completed', version: 1, routine: 'hourly', slot: request.slot, uuid: request.uuid, createdAt: NOW });
  expect(store.requests()).toHaveLength(1);
});

test('routine names are opaque and all names use the UTC-hour default', async () => {
  expect(await runAutomationCommand(['submit', 'unfinished-task-recovery', promptPath], deps())).toMatchObject({ status: 'accepted', routine: 'unfinished-task-recovery', slot: Date.parse('2026-10-06T15:00:00Z') });
});

test('explicit slots are shared across routine names and preserve milliseconds', async () => {
  for (const slot of ['2026-10-06T13:00:00Z', '2026-10-06T13:00:00.001Z']) {
    expect(await runAutomationCommand(['submit', 'daily', promptPath, '--slot', slot], deps())).toMatchObject({ status: 'accepted', routine: 'daily', slot: Date.parse(slot) });
  }
});

test('dry-run and empty status validate only and never create the store', async () => {
  const before = readdirSync(root);
  expect(await runAutomationCommand(['submit', 'hourly', promptPath, '--dry-run'], deps())).toMatchObject({ status: 'validated', dryRun: true, queued: false });
  expect(await runAutomationCommand(['status'], deps())).toEqual({ tasks: [] });
  expect(readdirSync(root)).toEqual(before);
});

test('dry-run reads inputs and checks directory safety but never calls a writer', async () => {
  const calls: string[] = [];
  const injected = {
    ...deps(),
    store: {
      validate: () => { calls.push('validate'); },
      submit: () => { throw new Error('write'); },
      requests: () => { throw new Error('read requests'); },
      statuses: () => { throw new Error('read status'); },
      finish: () => { throw new Error('write'); },
    },
    readPrompt: (path: string) => { expect(path).toBe(promptPath); calls.push('read prompt'); return 'test prompt'; },
  };
  await runAutomationCommand(['submit', 'hourly', promptPath, '--dry-run'], injected);
  expect(calls).toEqual(['read prompt', 'validate']);
});

test('status is read-only, filters a routine and reports pending until the runner records it', async () => {
  const request = store.submit('hourly', NOW, 'Secret prompt');
  store.submit('daily', NOW, 'Another secret');
  expect(await runAutomationCommand(['status', 'hourly'], deps())).toEqual({ tasks: [{ version: 1, uuid: request.uuid, routine: 'hourly', slot: NOW, createdAt: NOW, state: 'pending', token: null, updatedAt: null }] });
  expect(JSON.stringify(await runAutomationCommand(['status'], deps()))).not.toContain('secret');
  expect(store.status(request.uuid)).toBeNull();
});

test('status exposes safe runner dates, state and token while finish only saves an idempotent receipt', async () => {
  const request = store.submit('hourly', NOW, 'Private completion task');
  const token = randomUUID();
  const status = { uuid: request.uuid, state: 'awaiting-completion' as const, updatedAt: NOW, token, detail: 'sdk-completed' as const };
  store.saveStatus(status);
  expect(await runAutomationCommand(['status'], deps())).toEqual({ tasks: [{ version: 1, uuid: request.uuid, routine: 'hourly', slot: NOW, createdAt: NOW, state: status.state, token, updatedAt: NOW, detail: status.detail }] });
  for (const outcome of ['blocked', 'completed'] as const) {
    const receipt = await runAutomationCommand(['finish', request.uuid, token, outcome], deps());
    expect(receipt).toEqual({ status: 'accepted', verification: 'pending', uuid: request.uuid, requestedOutcome: outcome, createdAt: NOW });
    expect(await runAutomationCommand(['finish', request.uuid, token, outcome], deps())).toEqual(receipt);
    expect(store.status(request.uuid)).toEqual(status);
  }
  expect(store.resolutions()).toHaveLength(2);
  await expect(runAutomationCommand(['finish', request.uuid, randomUUID(), 'completed'], deps())).rejects.toThrow('token');
  expect(store.resolutions()).toHaveLength(2);
});

for (const args of [
  [], ['unknown'], ['submit'], ['submit', 'hourly'],
  ['submit', '../hourly', 'file'], ['submit', 'hourly', 'file', '--wat'],
  ['submit', 'hourly', 'file', '--slot'], ['submit', 'hourly', 'file', '--dry-run', '--dry-run'],
  ['submit', 'hourly', 'file', '--slot', '2026-10-06T15:00:00Z', '--slot', '2026-10-06T15:00:00Z'],
  ['status', 'hourly', 'extra'], ['status', '../hourly'], ['finish'], ['finish', 'uuid', 'token', 'failed'],
  ['finish', 'uuid', 'token', 'completed', 'extra'],
]) {
  test(`invalid arguments are refused without creating state: ${args.join(' ')}`, async () => {
    await expect(runAutomationCommand(args, deps())).rejects.toThrow();
    expect(readdirSync(root)).toEqual(['prompt.txt']);
  });
}

for (const slot of ['today', '2026-10-06', '2026-10-06T15:00:00+00:00', '2026-02-30T15:00:00Z', '2026-10-06T24:00:00Z', '2026-10-06T15:00:00.1Z']) {
  test(`noncanonical or invalid UTC slot is refused: ${slot}`, async () => {
    await expect(runAutomationCommand(['submit', 'hourly', promptPath, '--slot', slot], deps())).rejects.toThrow('UTC ISO');
    expect(readdirSync(root)).toEqual(['prompt.txt']);
  });
}

test('prompt files are bounded bytes, regular files, valid UTF-8 and never symbolic links', () => {
  writeFileSync(promptPath, 'x'.repeat(AUTOMATION_PROMPT_MAX));
  expect(readAutomationPrompt(promptPath)).toHaveLength(AUTOMATION_PROMPT_MAX);
  writeFileSync(promptPath, 'x'.repeat(AUTOMATION_PROMPT_MAX + 1));
  expect(() => readAutomationPrompt(promptPath)).toThrow('64 KiB');
  writeFileSync(promptPath, Buffer.from([0xff]));
  expect(() => readAutomationPrompt(promptPath)).toThrow('UTF-8');
  expect(() => readAutomationPrompt(root)).toThrow('regular');
  const link = join(root, 'link');
  symlinkSync(promptPath, link);
  expect(() => readAutomationPrompt(link)).toThrow('symbolic links');
  const dir = join(root, 'dir');
  mkdirSync(dir);
  writeFileSync(join(dir, 'file'), 'a prompt');
  symlinkSync(dir, join(root, 'linked-dir'));
  expect(() => readAutomationPrompt(join(root, 'linked-dir', 'file'))).toThrow('symbolic links');
});

test('dry-run rejects a linked automation directory without touching its target', async () => {
  const other = join(root, 'other');
  mkdirSync(other);
  symlinkSync(other, store.root);
  await expect(runAutomationCommand(['submit', 'hourly', promptPath, '--dry-run'], deps())).rejects.toThrow();
  expect(readdirSync(other)).toEqual([]);
});

test('absolute host commands survive missing metro PATH and whitespace or apostrophes in executable and entry paths', () => {
  const runtime = join(root, "runtime ' quoted");
  const src = join(runtime, 'src');
  const core = join(runtime, 'node_modules', '@metro-labs', 'core');
  mkdirSync(src, { recursive: true });
  mkdirSync(core, { recursive: true });
  for (const file of ['automation-cli.ts', 'automation-command.ts']) cpSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), join(src, file));
  cpSync(fileURLToPath(new URL('../../core/src', import.meta.url)), join(core, 'src'), { recursive: true });
  cpSync(fileURLToPath(new URL('../../core/package.json', import.meta.url)), join(core, 'package.json'));
  const executable = join(root, "bun ' quoted");
  symlinkSync(process.execPath, executable);
  const commandRuntime = { executable, entry: join(src, 'automation-cli.ts') };
  const request = store.submit('absolute-check', NOW, 'Private absolute command test');
  const token = randomUUID();
  store.saveStatus({ uuid: request.uuid, token, state: 'awaiting-completion', updatedAt: NOW });
  const run = (args: string[]) => spawnSync('/bin/sh', ['-c', automationShellCommand(args, commandRuntime)], {
    cwd: root, env: { HOME: root, METRO_RUNNER_STATE: join(root, 'session.json'), PATH: '/no-tools-on-path' }, encoding: 'utf8', timeout: 10_000,
  });
  const finished = run(['finish', request.uuid, token, 'completed']);
  expect(finished.status).toBe(0);
  expect(finished.stderr).toBe('');
  expect(JSON.parse(finished.stdout)).toMatchObject({ status: 'accepted', verification: 'pending', uuid: request.uuid });
  expect(store.resolutions()).toHaveLength(1);
  expect(store.status(request.uuid)?.state).toBe('awaiting-completion');
  const status = run(['status', request.routine]);
  expect(status.status).toBe(0);
  expect(status.stderr).toBe('');
  expect(JSON.parse(status.stdout).tasks).toHaveLength(1);
  expect(existsSync(join(root, '.bun'))).toBe(false);
  expect(automationShellCommand(['status'])).toContain(fileURLToPath(new URL('../src/automation-cli.ts', import.meta.url)));
});

test('unknown failures never print error paths, tokens or prompts', () => {
  const secret = 'private prompt and secret token';
  expect(automationCommandFailure(new Error(secret))).not.toContain(secret);
  expect(automationCommandFailure(secret)).not.toContain(secret);
  expect(automationCommandFailure({ message: secret })).not.toContain(secret);
});
