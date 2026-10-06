import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRunnerActivity } from '@metro-labs/core/runner-activity';
import { Activity } from '../src/activity.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function shutdown(event: string): Promise<{ code: number; stops: boolean[]; cleaned: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), 'metro-runner-main-'));
  dirs.push(dir);
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR', 'METRO_STATE_DIR', 'METRO_RUNTIME_STORE', 'METRO_RUNNER_STORE', 'TMPDIR']) {
    env[name] = join(dir, name);
    mkdirSync(env[name]);
  }
  const result = join(dir, 'result.json');
  const script = join(dir, 'main-fixture.ts');
  const source = (name: string): string => JSON.stringify(new URL(`../src/${name}.ts`, import.meta.url).pathname);
  writeFileSync(script, `
import { mock } from 'bun:test';
import { writeFileSync } from 'node:fs';
const result = { stops: [], cleaned: false };
const save = () => writeFileSync(${JSON.stringify(result)}, JSON.stringify(result));
save();
let finish;
let fail;
const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
mock.module(${source('config')}, () => ({ runnerConfig: () => ({ statePath: '${dir}/session.json' }) }));
mock.module(${source('activity')}, () => ({ Activity: class {
  constructor(_path, cancelSignal) { if (cancelSignal !== 'SIGUSR2') throw new Error('missing cancellation capability'); }
  fail() {}
}, failureSummary: () => 'fixture failure' }));
mock.module(${source('app')}, () => ({ startAgent: async (_cfg, hooks) => {
  const event = ${JSON.stringify(event)};
  if (event === 'startup') throw new Error('fixture startup failure');
  if (event.startsWith('starting-')) {
    setTimeout(() => {
      process.emit(event === 'starting-cancel' ? 'SIGUSR2' : 'SIGTERM');
      if (event === 'starting-escalate') process.emit('SIGUSR2');
    }, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
  } else setTimeout(() => {
    if (event === 'lost') hooks.lost('fixture disconnect');
    else if (event === 'ended') finish();
    else if (event === 'failed') fail(new Error('fixture failure'));
    else if (event === 'escalate') {
      process.emit('SIGTERM');
      setTimeout(() => { process.emit('SIGUSR2'); process.emit('SIGUSR2'); }, 5);
    } else { process.emit(event); process.emit('SIGHUP'); }
  }, 10);
  let stopped = false;
  return { done, stop: async (cancelActive) => {
    result.stops.push(cancelActive);
    save();
    if (stopped) return;
    stopped = true;
    finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    result.cleaned = true;
    save();
  } };
} }));
await import(${source('main')});
`);
  const child = Bun.spawn([process.execPath, script], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(error).not.toContain('error: Cannot find');
  const saved = JSON.parse(readFileSync(result, 'utf8')) as { stops: boolean[]; cleaned: boolean };
  return { code, ...saved };
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  test(`${signal} preserves active work and finishes shutdown once`, async () => {
    expect(await shutdown(signal)).toEqual({ code: 0, stops: [false], cleaned: true });
  });
}

test('the explicit owner cancellation signal cancels before later shutdown signals', async () => {
  expect(await shutdown('SIGUSR2')).toEqual({ code: 0, stops: [true], cleaned: true });
});

test('owner cancellation escalates an in-progress restart without cutting cleanup short', async () => {
  expect(await shutdown('escalate')).toEqual({ code: 0, stops: [false, true], cleaned: true });
});

for (const event of ['starting-preserve', 'starting-cancel', 'starting-escalate']) {
  test(`${event} waits for the agent before applying the final stop intent`, async () => {
    expect(await shutdown(event)).toEqual({ code: 0, stops: [event !== 'starting-preserve'], cleaned: true });
  });
}

for (const event of ['lost', 'ended', 'failed']) {
  test(`${event} leaves active work recoverable`, async () => {
    expect(await shutdown(event)).toEqual({ code: 1, stops: [false], cleaned: true });
  });
}

test('a startup failure exits without inventing a cancellation', async () => {
  expect(await shutdown('startup')).toEqual({ code: 1, stops: [], cleaned: false });
});

test('activity advertises cancellation only when the entrypoint opts in, and parses only the known signal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metro-runner-capability-'));
  dirs.push(dir);
  const path = join(dir, 'activity.json');
  for (const signal of [undefined, 'SIGUSR2'] as const) {
    const activity = new Activity(path, signal);
    try {
      activity.start();
      const saved: unknown = JSON.parse(readFileSync(path, 'utf8'));
      expect(parseRunnerActivity(saved)?.cancelSignal).toBe(signal);
      for (const invalid of ['SIGTERM', 'SIGUSR1', '-KILL', true])
        expect(parseRunnerActivity({ ...activity.snapshot(), cancelSignal: invalid })).not.toHaveProperty('cancelSignal');
    } finally {
      activity.stop();
    }
  }
});
