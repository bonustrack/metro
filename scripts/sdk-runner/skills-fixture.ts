import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GitHubSkills } from '../../apps/daemon/src/claude/github-skills.js';
import { FakeGitHub, SOURCE, skill } from '../../apps/daemon/test/github-skills-helper.js';
import { hearSharedCall } from '../../apps/daemon/src/voice/shared.js';
import { type SkillActivation } from '../../packages/core/src/skill-source.js';
import * as h from './shared-call-harness.js';

const claude = join(h.ROOT, 'claude');
const github = new FakeGitHub();
const source = new GitHubSkills({ agents: join(h.ROOT, 'agents'), claude, sdk: () => true, request: github.fetch });
const state = (): SkillActivation => JSON.parse(readFileSync(join(source.root, 'status.json'), 'utf8')) as SkillActivation;
const local = join(claude, 'skills/local-fixture');
mkdirSync(local, { recursive: true });
writeFileSync(join(local, 'SKILL.md'), skill('local-fixture', 'LOCAL_BODY'));

function installPlugin(): string {
  const marketplace = join(h.ROOT, 'marketplace');
  const plugin = join(marketplace, 'plugin');
  mkdirSync(join(marketplace, '.claude-plugin'), { recursive: true });
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  mkdirSync(join(plugin, 'skills/identity-fixture'), { recursive: true });
  writeFileSync(join(marketplace, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'metro', owner: { name: 'Fixture' }, plugins: [{ name: 'metro', source: './plugin', version: '1.0.0' }] }));
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'metro', version: '1.0.0' }));
  writeFileSync(join(plugin, 'skills/identity-fixture/SKILL.md'), skill('identity-fixture', 'PLUGIN_BODY'));
  const sdkRequire = createRequire(createRequire(new URL('../../packages/sdk-runner/package.json', import.meta.url)).resolve('@anthropic-ai/claude-agent-sdk'));
  const binary = join(dirname(sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)), 'claude');
  for (const args of [['plugin', 'marketplace', 'add', marketplace], ['plugin', 'install', 'metro@metro', '-y', '--scope', 'user']]) execFileSync(binary, args, { cwd: join(h.ROOT, 'home'), env: process.env, timeout: 45_000, stdio: 'pipe' });
  return binary;
}

const binary = installPlugin();
let releaseWorker: (() => void) | undefined;
let heldWorker = false;
h.upstream.script = async ({ text, worker }) => {
  if (!worker && text.includes('PROBE_WORKER')) return [{ type: 'tool_use', name: 'Agent', input: { description: 'Skills safety fixture', prompt: 'FIXTURE_WORKER HOLD_SKILL', subagent_type: 'general-purpose', run_in_background: true } }];
  if (worker && text.includes('HOLD_SKILL')) {
    heldWorker = true;
    await new Promise<void>((resolve) => { releaseWorker = resolve; });
    return [{ type: 'text', text: 'Worker finished.' }];
  }
  const invoke = /PROBE_INVOKE ([a-z0-9:-]+)/.exec(text);
  if (invoke) return [{ type: 'tool_use', name: 'Agent', input: { description: 'Invoke fixture skill', prompt: `FIXTURE_WORKER SKILL_INVOKE ${invoke[1]}`, subagent_type: 'general-purpose', run_in_background: true } }];
  const skillName = /SKILL_INVOKE ([a-z0-9:-]+)/.exec(text);
  if (worker && skillName) return [{ type: 'tool_use', name: 'Skill', input: { skill: skillName[1] } }];
  return [{ type: 'text', text: 'Fixture finished.' }];
};

async function settled(): Promise<void> {
  await h.idle();
  await h.until('workers finished', () => h.activity.snapshot().workers === 0);
  await Bun.sleep(150);
}

async function applied(previous: string | null): Promise<void> {
  await h.until('skills acknowledged', () => state().generation !== null && state().generation !== previous);
  assert.equal(state().problem, null);
}

async function stage(marker: string): Promise<void> {
  github.files.set('team-example/SKILL.md', skill('team-example', marker));
  await source.sync(true);
}

async function invoke(name: string, marker: string): Promise<void> {
  const before = h.upstream.seen.length;
  h.chat(`PROBE_INVOKE ${name}`);
  await h.until(`fresh body ${marker}`, () => h.upstream.seen.slice(before).some((request) => request.text.includes(marker)));
  await settled();
}

async function exercise(disabled: boolean): Promise<void> {
  const settings = readFileSync(join(claude, 'settings.json'), 'utf8');
  const eventStart = h.events.length;
  await source.configure(SOURCE);
  const prepared = (JSON.parse(readFileSync(join(source.root, 'pending.json'), 'utf8')) as { id: string }).id;
  await h.boot();
  await h.until('startup revision loaded', () => state().generation === prepared);
  await invoke('team-example', 'Do the task.');
  const session = h.agent.runner.id;
  assert.ok(session);
  const first = state().generation;
  h.chat('PROBE_WORKER');
  await h.until('held background worker', () => heldWorker);
  await h.idle();
  await stage(`HELD_BODY_${disabled}`);
  await Bun.sleep(1200);
  assert.equal(state().generation, first, 'A running worker retains its generation');
  h.agent.runner.inbox.automation('SCHEDULED_WHILE_WORKER', randomUUID(), Date.now());
  const call = await h.call();
  hearSharedCall(call.route, 'VOICE_WHILE_WORKER', randomUUID());
  releaseWorker?.();
  await settled();
  await Bun.sleep(1200);
  assert.equal(state().generation, first, 'A live shared call retains its generation');
  call.end();
  await applied(first);
  await invoke('team-example', `HELD_BODY_${disabled}`);
  const second = state().generation;
  const requests = h.upstream.seen.length;
  await stage(`BODY_ONLY_${disabled}`);
  await applied(second);
  assert.equal(h.upstream.seen.length, requests, 'Skills-only reload makes no model request');
  await invoke('team-example', `BODY_ONLY_${disabled}`);
  await invoke('local-fixture', 'LOCAL_BODY');
  const collision = join(claude, 'skills/team-example');
  mkdirSync(collision, { recursive: true });
  writeFileSync(join(collision, 'SKILL.md'), skill('team-example', `LOCAL_COLLISION_${disabled}`));
  await h.until('collision filtered', () => state().shadowed.includes('team-example'));
  await invoke('team-example', `LOCAL_COLLISION_${disabled}`);
  rmSync(collision, { recursive: true });
  await h.until('collision removed', () => !state().shadowed.includes('team-example'));
  const prior = state().generation;
  await source.remove();
  await applied(prior);
  assert.deepEqual(source.rows(), []);
  github.files.set('team-example/SKILL.md', skill('team-example', `READDED_${disabled}`));
  const removed = state().generation;
  await source.configure(SOURCE);
  await applied(removed);
  await invoke('team-example', `READDED_${disabled}`);
  assert.equal(h.agent.runner.id, session);
  assert.equal(readFileSync(join(claude, 'settings.json'), 'utf8'), settings);
  const init = h.events.slice(eventStart).find((event) => event.type === 'system' && event.subtype === 'init');
  assert.ok(init);
  assert.equal(JSON.stringify(init).includes('metro:identity-fixture'), !disabled);
  assert.ok(h.upstream.seen.some((request) => request.text.includes('SCHEDULED_WHILE_WORKER')));
  assert.ok(h.upstream.seen.some((request) => request.text.includes('VOICE_WHILE_WORKER')));
  h.report('PASS production GitHub stage, Runner safe activation, chat/shared voice/scheduled/worker, body edit/local collision/remove/readd', { disabled, session });
  await h.agent.stop();
  await h.agent.done;
  heldWorker = false;
}

try {
  await exercise(false);
  execFileSync(binary, ['plugin', 'disable', 'metro@metro', '--scope', 'user'], { cwd: join(h.ROOT, 'home'), env: process.env, timeout: 45_000, stdio: 'pipe' });
  github.files.set('team-example/SKILL.md', skill());
  await exercise(true);
  assert.deepEqual(h.upstream.failures, []);
  h.report('PASS ordinary installed plugin enabled/disabled, no inline plugins, local-only SDK upstream');
} finally { releaseWorker?.(); await h.close(); }
