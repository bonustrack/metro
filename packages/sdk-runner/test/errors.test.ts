import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { parseRunnerActivity } from '@metro-labs/core/runner-activity';
import { Activity } from '../src/activity.ts';
import { failureSummary, sessionFailure, SessionError, StartupDiagnostics } from '../src/errors.ts';
import { Runner, type OpenSession } from '../src/runner.ts';
import { SessionStore } from '../src/session-store.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const privateText = 'Bearer secret-bearer sk-ant-secret-api eyJsecret.jwt.value https://user:secret-password@private.invalid/secret-path?token=secret-query /home/private-owner/secret-file C:\\Users\\private-owner\\secret-file OWNER_MESSAGE prompt=secret-prompt tool_args=secret-args x-metro-key: secret-header';
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'metro-sdk-diagnostics-'));
  dirs.push(dir);
  return dir;
};

test('exceptions classify auth, config, process, module and transport without retaining their messages', () => {
  const cases = [
    { err: { status: 401, message: privateText }, code: 'authentication', diagnostic: { httpStatus: 401 } },
    { err: new Error(`METRO_AGENT_KEY is not set; ${privateText}`), code: 'configuration' },
    { err: new Error(`Claude Code process exited with code 1\n${privateText}`), code: 'process_exit', diagnostic: { exitCode: 1 } },
    { err: new Error(`Claude Code process terminated by signal SIGKILL\n${privateText}`), code: 'process_exit', diagnostic: { signal: 'SIGKILL' } },
    { err: { code: 'ERR_MODULE_NOT_FOUND', message: privateText }, code: 'module', diagnostic: { errorCode: 'ERR_MODULE_NOT_FOUND' } },
    { err: { code: 'EACCES', message: privateText }, code: 'executable', diagnostic: { errorCode: 'EACCES' } },
    { err: { code: 'ECONNREFUSED', message: privateText }, code: 'connection', diagnostic: { errorCode: 'ECONNREFUSED' } },
    { err: { status: 429, message: privateText }, code: 'rate_limit', diagnostic: { httpStatus: 429 } },
    { err: { statusCode: 503, message: privateText }, code: 'provider_unavailable', diagnostic: { httpStatus: 503 } },
  ];
  for (const entry of cases) {
    const failure = sessionFailure(entry.err);
    expect(failure).toMatchObject({ code: entry.code, diagnostic: { source: 'exception', ...entry.diagnostic } });
    const output = JSON.stringify(failure) + failureSummary(entry.err);
    expect(output.length).toBeLessThan(512);
    for (const secret of ['secret-', 'private-owner', 'private.invalid', 'OWNER_MESSAGE', 'eyJsecret']) expect(output).not.toContain(secret);
  }
  expect(sessionFailure(new Error(privateText))).toEqual({ code: 'session_error' });
});

test('bounded nested causes are inspected without stringifying objects, traversing stacks or following cycles forever', () => {
  const error = new Error(privateText, { cause: { code: 'ERR_MODULE_NOT_FOUND', message: privateText } });
  expect(sessionFailure(error)).toMatchObject({ code: 'module', diagnostic: { source: 'exception', errorCode: 'ERR_MODULE_NOT_FOUND' } });
  const cycle: Record<string, unknown> = { code: 'ETIMEDOUT', stack: privateText };
  cycle.cause = cycle;
  expect(sessionFailure(cycle).code).toBe('connection');
  expect(sessionFailure({ toString: () => { throw new Error(privateText); } })).toEqual({ code: 'session_error' });
  expect(sessionFailure({ get message() { throw new Error(privateText); } })).toEqual({ code: 'session_error' });
  expect(sessionFailure({ cause: { cause: { cause: { cause: error } } } })).toEqual({ code: 'session_error' });
  expect(sessionFailure(new Error(`${'x'.repeat(10_000)} ERR_MODULE_NOT_FOUND`))).toEqual({ code: 'session_error' });
});

test('startup stderr keeps only allowlisted evidence across chunks and augments a generic process failure', () => {
  const diagnostics = new StartupDiagnostics();
  diagnostics.stderr('x'.repeat(100_000));
  diagnostics.stderr(`Error [ERR_MODULE_`);
  diagnostics.stderr(`NOT_FOUND]: Cannot find package ${privateText}`);
  diagnostics.stderr(`Claude Code process exited with code 1\n${privateText}`);
  const failure = diagnostics.failure(new Error(`Claude Code process exited with code 1\n${privateText}`));
  expect(failure).toEqual({ code: 'module', diagnostic: { source: 'stderr', errorCode: 'ERR_MODULE_NOT_FOUND', exitCode: 1 } });
  expect(JSON.stringify(diagnostics).length).toBeLessThan(2_500);
  expect(failureSummary(new SessionError(failure))).toContain('ERR_MODULE_NOT_FOUND, exit 1 (startup stderr)');
  expect(diagnostics.failure({ status: 401, message: privateText })).toMatchObject({ code: 'authentication', diagnostic: { source: 'exception', httpStatus: 401 } });
  diagnostics.clear();
  expect(diagnostics.failure(new Error(privateText))).toEqual({ code: 'session_error' });
  expect(JSON.stringify(diagnostics)).not.toContain('secret-');
});

test('unknown stderr stays unknown, and large chunks scan only bounded head and tail', () => {
  const diagnostics = new StartupDiagnostics();
  diagnostics.stderr(privateText.repeat(10_000));
  expect(diagnostics.failure(new Error('unknown'))).toEqual({ code: 'session_error' });
  expect(JSON.stringify(diagnostics).length).toBeLessThan(2_500);
  diagnostics.stderr(`${'x'.repeat(100_000)}\nError: MODULE_NOT_FOUND ${privateText}`);
  expect(diagnostics.failure('unknown')).toMatchObject({ code: 'module', diagnostic: { errorCode: 'MODULE_NOT_FOUND' } });
});

test('safe exception wrappers copy only the allowlisted diagnostic', () => {
  const diagnostic = { source: 'exception' as const, errorCode: 'ERR_MODULE_NOT_FOUND' as const, message: privateText, stderr: privateText, headers: privateText };
  const error = new SessionError({ code: 'module', diagnostic });
  expect(error.failure).toEqual({ code: 'module', diagnostic: { source: 'exception', errorCode: 'ERR_MODULE_NOT_FOUND' } });
  expect(JSON.stringify(error) + error.message).not.toContain('secret-');
});

test('session failures re-normalize enriched and forged exception wrappers', () => {
  const diagnostic = { source: 'stderr' as const, errorCode: 'ERR_MODULE_NOT_FOUND' as const, exitCode: 1, message: privateText, stderr: privateText, headers: { authorization: privateText } };
  const enriched = new SessionError({ code: 'module', diagnostic });
  Object.assign(enriched.failure, { message: privateText, summary: privateText });
  Object.assign(enriched.failure.diagnostic ?? {}, diagnostic);
  const forged: unknown = Object.setPrototypeOf({ message: privateText, failure: { code: 'module', diagnostic, summary: privateText } }, SessionError.prototype);
  const expected = { code: 'module', diagnostic: { source: 'stderr', errorCode: 'ERR_MODULE_NOT_FOUND', exitCode: 1 } };
  for (const error of [enriched, forged]) {
    expect(error).toBeInstanceOf(SessionError);
    expect(sessionFailure(error)).toEqual(expected);
    expect(JSON.stringify(sessionFailure(error)) + failureSummary(error)).not.toContain('secret-');
  }
  const safe = sessionFailure(enriched);
  expect(safe).not.toBe(enriched.failure);
  expect(safe.diagnostic).not.toBe(enriched.failure.diagnostic);
  Object.assign(enriched.failure.diagnostic ?? {}, { exitCode: 255, message: privateText });
  expect(safe).toEqual(expected);
});

test('forged exception wrappers reject unknown and inherited failure codes', () => {
  for (const code of ['SYNTHETIC_PRIVATE', 'constructor', '__proto__', null, {}]) {
    const forged: unknown = Object.setPrototypeOf({ failure: { code, diagnostic: { source: 'exception', exitCode: 1, message: privateText } } }, SessionError.prototype);
    expect(sessionFailure(forged)).toEqual({ code: 'session_error' });
    expect(failureSummary(forged)).toBe('The Agent SDK session failed. Check Terminal and the Model page.');
  }
});

function fakeRunner(open: OpenSession): Runner {
  const dir = temp();
  return new Runner({ store: new SessionStore(join(dir, 'session.json'), join(dir, 'claude'), dir), readOnly: () => false, open });
}

test('synchronous SDK open failures retain safe startup evidence before the collector is cleared', () => {
  const runner = fakeRunner(({ options }) => {
    options.stderr?.(`Error [ERR_MODULE_NOT_FOUND]: ${privateText}`);
    throw new Error(`Claude Code process exited with code 1\n${privateText}`);
  });
  try {
    let error: unknown;
    try { runner.start({}); } catch (err) { error = err; }
    expect(error).toBeInstanceOf(SessionError);
    expect(sessionFailure(error)).toEqual({ code: 'module', diagnostic: { source: 'stderr', errorCode: 'ERR_MODULE_NOT_FOUND', exitCode: 1 } });
    expect(JSON.stringify(error) + failureSummary(error)).not.toContain('secret-');
  } finally { runner.close(); }
});

test('SDK init clears startup warnings and later tool stderr is never used to classify a session failure', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const runner = fakeRunner(({ options }) => {
    options.stderr?.(`Error [ERR_MODULE_NOT_FOUND]: ${privateText}`);
    return {
      applyFlagSettings: () => Promise.resolve(), close: () => undefined,
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: id, model: 'fixture', claude_code_version: 'fixture' } as SDKMessage;
        options.stderr?.(`Error [EACCES]: ${privateText}`);
        throw new Error(privateText);
      },
    } as ReturnType<OpenSession>;
  });
  try {
    runner.start({});
    await expect(runner.run()).rejects.toMatchObject({ failure: { code: 'session_error' } });
    expect(runner.id).toBe(id);
  } finally { runner.close(); }
});

test('failure status is bounded, private and retained through stop with independent snapshot copies', () => {
  const path = join(temp(), 'status.json');
  const activity = new Activity(path);
  activity.start();
  try {
    for (let i = 0; i < 100; i++) activity.fail({ code: 'ERR_MODULE_NOT_FOUND', message: privateText.repeat(1_000), headers: privateText, config: privateText });
    activity.stop();
    const file = readFileSync(path, 'utf8');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(file.length).toBeLessThan(32_000);
    expect(file).not.toContain('secret-');
    expect(file).not.toContain('OWNER_MESSAGE');
    const parsed = parseRunnerActivity(JSON.parse(file));
    expect(parsed).toMatchObject({ phase: 'error', sessionId: null, activeFailure: { code: 'module', diagnostic: { source: 'exception', errorCode: 'ERR_MODULE_NOT_FOUND' } } });
    expect(parsed?.events).toHaveLength(40);
    const copy = activity.snapshot();
    if (copy.activeFailure?.diagnostic) copy.activeFailure.diagnostic.errorCode = 'ENOENT';
    expect(activity.snapshot().activeFailure?.diagnostic?.errorCode).toBe('ERR_MODULE_NOT_FOUND');
  } finally { activity.stop(); }
});

test('enriched and forged wrappers cannot leak into raw status files or normal logs', async () => {
  const dir = temp();
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR', 'METRO_STATE_DIR', 'TMPDIR']) {
    env[name] = join(dir, name);
    mkdirSync(env[name]);
  }
  const script = join(dir, 'wrappers.ts');
  const paths = ['enriched', 'forged', 'unknown'].map((name) => join(dir, `${name}.json`));
  const source = (name: string): string => JSON.stringify(new URL(`../src/${name}.ts`, import.meta.url).pathname);
  writeFileSync(script, `
import { Activity } from ${source('activity')};
import { SessionError } from ${source('errors')};
const privateText = ${JSON.stringify(privateText)};
const diagnostic = { source: 'stderr', errorCode: 'ERR_MODULE_NOT_FOUND', exitCode: 1, message: 'SYNTHETIC_PRIVATE', stderr: privateText, stack: privateText, headers: { authorization: privateText }, endpoint: privateText };
const enriched = new SessionError({ code: 'module', diagnostic });
Object.assign(enriched.failure, { message: privateText, summary: privateText });
Object.assign(enriched.failure.diagnostic, diagnostic);
const forged = Object.setPrototypeOf({ message: privateText, failure: { code: 'module', diagnostic, summary: privateText } }, SessionError.prototype);
const unknown = Object.setPrototypeOf({ failure: { code: 'SYNTHETIC_PRIVATE', diagnostic } }, SessionError.prototype);
const errors = [enriched, forged, unknown];
const paths = ${JSON.stringify(paths)};
for (let i = 0; i < errors.length; i++) {
  const activity = new Activity(paths[i]);
  activity.start();
  try {
    activity.fail(errors[i]);
    Object.assign(errors[i].failure.diagnostic, { exitCode: 255, message: 'AFTER_FAIL_PRIVATE' });
  } finally { activity.stop(); }
  diagnostic.exitCode = 1;
}
`);
  const child = Bun.spawn([process.execPath, script], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit).toBe(0);
  expect(stdout).toBe('');
  expect(stderr).toContain('sdk-runner: activity error');
  expect(stderr).toContain('"reason":"module"');
  expect(stderr).toContain('ERR_MODULE_NOT_FOUND');
  expect(stderr).toContain('"exitCode":1');
  for (const [index, path] of paths.entries()) {
    const file = readFileSync(path, 'utf8');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    for (const secret of ['SYNTHETIC_PRIVATE', 'AFTER_FAIL_PRIVATE', 'secret-', 'private-owner', 'private.invalid', 'OWNER_MESSAGE', 'eyJsecret']) expect(stderr + file).not.toContain(secret);
    const raw: unknown = JSON.parse(file);
    const failure = index < 2 ? { code: 'module', diagnostic: { source: 'stderr', errorCode: 'ERR_MODULE_NOT_FOUND', exitCode: 1 } } : { code: 'session_error' };
    expect(raw).toMatchObject({ phase: 'error', activeFailure: failure, lastFailure: failure, events: [expect.objectContaining(failure)] });
    expect(parseRunnerActivity(raw)?.activeFailure).toMatchObject(failure);
  }
});

test('a fake SDK startup exit reaches normal logs and status without raw stderr, keys, paths or owner content', async () => {
  const dir = temp();
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR', 'METRO_STATE_DIR', 'TMPDIR']) {
    env[name] = join(dir, name);
    mkdirSync(env[name]);
  }
  const script = join(dir, 'fixture.ts');
  const path = join(dir, 'status.json');
  const source = (name: string): string => JSON.stringify(new URL(`../src/${name}.ts`, import.meta.url).pathname);
  writeFileSync(script, `
import { Activity } from ${source('activity')};
import { Runner } from ${source('runner')};
import { SessionStore } from ${source('session-store')};
const activity = new Activity(${JSON.stringify(path)});
activity.start();
const runner = new Runner({ store: new SessionStore(${JSON.stringify(join(dir, 'session.json'))}, ${JSON.stringify(env.CLAUDE_CONFIG_DIR)}, ${JSON.stringify(dir)}), readOnly: () => false, activity,
  open: ({ options }) => {
    options.stderr('Error [ERR_MODULE_');
    options.stderr('NOT_FOUND]: Cannot find package ' + ${JSON.stringify(privateText)});
    return { applyFlagSettings: async () => {}, close() {}, async *[Symbol.asyncIterator]() { throw new Error('Claude Code process exited with code 1\\n' + ${JSON.stringify(privateText)}); } };
  }
});
try {
  runner.start({ cwd: ${JSON.stringify(dir)} });
  await runner.run();
} catch (err) { activity.fail(err); }
finally { runner.close(); activity.stop(); }
`);
  const child = Bun.spawn([process.execPath, script], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit).toBe(0);
  expect(stdout).toBe('');
  const file = readFileSync(path, 'utf8');
  expect(stderr).toContain('sdk-runner: activity error');
  expect(stderr).toContain('ERR_MODULE_NOT_FOUND');
  expect(stderr).toContain('"exitCode":1');
  for (const secret of ['secret-', 'private-owner', 'private.invalid', 'OWNER_MESSAGE', 'eyJsecret', 'Cannot find package']) expect(stderr + file).not.toContain(secret);
  expect(parseRunnerActivity(JSON.parse(file))?.activeFailure).toMatchObject({ code: 'module', diagnostic: { source: 'stderr', errorCode: 'ERR_MODULE_NOT_FOUND', exitCode: 1 } });
});
