import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setBearerSessions } from '../../packages/http/src/api-http.ts';
import { parseRunnerActivity, type RunnerActivity } from '../../packages/core/src/runner-activity.ts';
import { Activity } from '../../packages/sdk-runner/src/activity.ts';

process.env.SDK_RUNNER_CHECK_ROUTE = 'scripted';
process.env.SDK_RUNNER_CHECK_MODEL = 'openrouter:vendor/model-a';
process.env.SDK_RUNNER_WORKER_DELAY_MS = '3000';
const h = await import('./harness.ts');
const { handleClaudeRequest } = await import('../../apps/daemon/src/claude/api.ts');
writeFileSync(join(h.AGENTS, 'model.json'), JSON.stringify({ version: 2, route: 'or', connections: [{ id: 'or', provider: 'openrouter', label: 'Fixture', model: 'vendor/model-a', apiKey: 'fixture-key', region: '', zdr: false }] }));
writeFileSync(join(h.AGENTS, 'claude-setup.json'), JSON.stringify({ runner: 'sdk' }));
setBearerSessions(() => Promise.resolve({ subject: 'activity-fixture', role: 'admin' }));
h.serveAlso((req, res) => handleClaudeRequest(req, res, {
  dir: () => h.CLAUDE_DIR,
  session: { home: h.WORK, agents: h.AGENTS, metro: ['fixture'], signedIn: () => true },
}));

const path = join(h.WORK, '.metro', 'agent-status.json');
const samples: RunnerActivity[] = [];
async function poll(): Promise<RunnerActivity> {
  const res = await fetch(`${h.BASE}/api/claude/session`, { headers: { authorization: 'Bearer fixture' } });
  assert.equal(res.status, 200);
  const body = await res.json() as { activity?: unknown };
  const state = parseRunnerActivity(body.activity);
  assert.ok(state);
  samples.push(state);
  return state;
}
async function waitFor(predicate: (state: RunnerActivity) => boolean): Promise<RunnerActivity> {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const state = await poll();
    if (predicate(state)) return state;
    await h.sleep(100);
  }
  throw new Error('Live activity did not reach the expected state');
}

const activity = new Activity(path);
const agent = await h.boot(10_000_000, activity);
try {
  const started = await waitFor((state) => state.mainPhase === 'idle');
  h.chat(h.LESS, 'DELEGATE a background worker. PRIVATE-FIXTURE-CONTENT');
  const running = await waitFor((state) => state.workers > 0 && state.tasks.some((task) => task.status === 'running'));
  const parallel = await waitFor((state) => state.mainPhase === 'idle' && state.workers > 0);
  h.chat(h.LESS, 'Answer this chat while the worker runs.');
  await h.until('chat during background work', () => h.sendsOn(h.LINE, 0).length > 0, 30_000);
  const finished = await waitFor((state) => state.tasks.some((task) => task.status === 'completed') && state.workers === 0);
  assert.equal(running.sessionId, finished.sessionId);
  assert.ok(running.updatedAt > started.updatedAt);
  assert.ok(finished.updatedAt >= parallel.updatedAt);
  assert.ok(running.tasks[0]?.startedAt);
  assert.ok(finished.events.some((event) => event.kind === 'task_completed'));
  assert.ok(!readFileSync(path, 'utf8').includes('PRIVATE-FIXTURE-CONTENT'));
  await agent.stop();
  assert.equal((await poll()).phase, 'stopped');
  h.say('activity_proof', { polls: samples.length, session: finished.sessionId, runningWorkers: running.workers, mainWhileWorkerRuns: parallel.mainPhase, finishedWorkers: finished.workers, finalTaskState: finished.tasks[0]?.status, stopped: true, sanitized: true, cost: 0 });
} finally {
  await agent.stop();
  h.close();
}
process.exit(0);
