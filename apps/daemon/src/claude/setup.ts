import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { existsSync, readFileSync, statSync } from '../agent-user/agent-fs.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { writeAtomic } from '@metro-labs/core/secure-fs';
import { agentsDir } from '../agents/files.js';
import { moveHome, removeHome, writeHomeText } from '../agent-user/home-fs.js';
import { claudeDir } from './files.js';
import { memoryJobStatus, type MemoryJob } from './memory-routine.js';
import { stagedMarketplaceDir } from './plugin-install.js';
import { readModelConfig, routedConnection, type ModelConfig } from '../gateway/model-config.js';
import { harnessRunner, runnerModel, sdkAllowed, sdkOnLogin, type HarnessRunner } from './runner.js';
import { readSetupState, writeSetupState } from './setup-state.js';

export const PRIVACY_ENV: Record<string, string> = {
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF: '1',
};
export const RETENTION_DAYS = 7;
const RULES_FILE = 'METRO.md';
const RULES_SKILL = 'metro';
const RENAMED_SKILL = 'metro-orchestrator';
const RENAMED_NAME = /^name:[ \t]*(["']?)metro-orchestrator\1[ \t]*$/m;
const SYSTEM_PROMPT_FILE = 'system-prompt.md';
export const SYSTEM_PROMPT_MAX = 64 * 1024;

const WORKER_AGENT = `---
name: worker
description: Default execution agent for delegated work. Full tool access and maximum reasoning effort. Use for any substantive task the orchestrator main thread cannot perform itself - reading and writing code, running commands, research, analysis.
effort: xhigh
---

You are a worker agent. The main thread that dispatched you is an orchestrator with no file, shell or network access; it can only delegate and relay messages. That means you are where the actual work happens, and the quality of your output is the quality of the result.

Work to completion. Do not hand back a partial answer with a suggestion that someone else finish it; there is no one else. If part of the task is genuinely blocked, complete every other part in full and say plainly what you left undone and why. Before you finish, read your own last paragraph: if it is a plan, a question or a promise about work you have not done, do that work now.

Keep the change to what the task asks for. A pre-existing bug, a performance problem or behaviour the task does not mention is a follow-up to report at the end, not something to fix now, unless the requested behaviour cannot work without it. Where the task is ambiguous, build the reading its wording and the surrounding code support best, and state that assumption. Commit tests only where the task asks for them or the repository already keeps tests for that kind of change, sized like the neighbouring test files; scratch checks you used to verify yourself need not be kept. This is about extras only: every behaviour the task does ask for, implement completely.

Never call AskUserQuestion or ExitPlanMode. They are blocked by policy, because nobody is watching the terminal around the clock and a blocking prompt stalls indefinitely. When you hit an ambiguity: do everything that does not depend on it, then choose the most reasonable interpretation, state the assumption explicitly in your report, and continue.

Your final message is a report to the orchestrator, not a message to a human. It gets relayed onward, so make it self-contained and concise. Lead with the outcome. Include concrete evidence, command output, file paths with line numbers, test results, for anything you claim to have verified. Report failures faithfully: if a test failed, say so and show the output; if you skipped a step, say that too.
`;

export interface SetupDeps {
  dir?: string;
  agents?: string;
  plugin?: string;
  env?: NodeJS.ProcessEnv;
}

export type Placed = 'written' | 'present' | 'updated' | 'missing';
export type SettingsOutcome = 'written' | 'unchanged' | 'unreadable';

export interface SetupReport {
  privacy: boolean;
  guard: 'plugin';
  worker: Placed;
  skill: Placed;
  stage: Placed;
  memory: Placed;
  settings: SettingsOutcome;
}

export interface SetupStatus {
  privacy: boolean;
  permissionMode: PermissionMode;
  runner: HarnessRunner;
  runnerAllowed: boolean;
  sdkOnLogin: boolean;
  systemPrompt: string;
  liveEvents: boolean;
  memoryRoutine: boolean;
  memoryJob: MemoryJob;
  guard: 'plugin';
  worker: boolean;
  skill: boolean;
  stage: boolean;
  memory: boolean;
  privacyApplied: boolean;
  retentionDays: number | null;
}

const PERMISSION_MODES = ['auto', 'bypass'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

const privacyEnabled = (agents = agentsDir()): boolean => readSetupState(agents).privacy !== false;

export function setPrivacy(enabled: boolean, agents = agentsDir()): void {
  writeSetupState(agents, { privacy: enabled });
}

export const isPermissionMode = (value: unknown): value is PermissionMode => PERMISSION_MODES.some((m) => m === value);

export function permissionMode(agents = agentsDir()): PermissionMode {
  const mode = readSetupState(agents).permissionMode;
  return isPermissionMode(mode) ? mode : 'auto';
}

export function setPermissionMode(mode: PermissionMode, agents = agentsDir()): void {
  writeSetupState(agents, { permissionMode: mode });
}

export const liveEvents = (agents = agentsDir()): boolean => readSetupState(agents).liveEvents !== false;

export function setLiveEvents(on: boolean, agents = agentsDir()): void {
  writeSetupState(agents, { liveEvents: on });
}

export const memoryRoutine = (agents = agentsDir()): boolean => readSetupState(agents).memoryRoutine !== false;

export function setMemoryRoutine(on: boolean, agents = agentsDir()): void {
  writeSetupState(agents, { memoryRoutine: on });
}

const promptPath = (agents: string): string => join(agents, SYSTEM_PROMPT_FILE);

export function systemPrompt(agents = agentsDir()): string {
  const path = promptPath(agents);
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8').trim();
}

export function setSystemPrompt(text: string, agents = agentsDir()): void {
  const trimmed = text.trim();
  if (trimmed === '') {
    rmSync(promptPath(agents), { force: true });
    return;
  }
  writeAtomic(promptPath(agents), `${trimmed}\n`, 0o600);
}

function pluginDir(env: NodeJS.ProcessEnv = process.env): string {
  const staged = stagedMarketplaceDir(env);
  if (staged !== null) {
    const dir = join(staged, 'plugin');
    if (existsSync(join(dir, RULES_FILE))) return dir;
  }
  return fileURLToPath(new URL('../../../../plugin', import.meta.url));
}

const PRIOR_WORKER: ReadonlySet<string> = new Set(['08a0cd8710df285d6512245246bb8b658b7cfc7f3e89490514ee5376779eb2ef']);
const PRIOR_METRO: ReadonlySet<string> = new Set([
  '0b3d122ed95beff09d579cf912cd4238e1db524c41fce4b314de57d6ff5908ad',
  '36f4fb57f231a119d717b5e3d6ccb654f94960fcca708683f376679aead8df25',
  '3840bc50253e51f431691376cf29a925b8245d87b77b8b20804a159e378a6e67',
  'e6b59eba825b4568dfa9ace5049fd9568a2e10d731719976ad2657084fd4e5f9',
  '5ce3f76d610aae91adc922d0edc6c8be1f27aa2fec4a5e3a6d6231a04fb9310b',
  'b910597d24f31fa479b130a2545f94dd23684d802d99e36b637fc57c818a33be',
]);
const PRIOR_STAGE: ReadonlySet<string> = new Set([
  'dd7d30474765de3865ddc87c1cf3220161ded09502027cdff18597e5df0aab43',
  '47439ecbe661ca70471a6839ab30a963714c296ad8c14ca23c6eebc3929038cc',
  'e3b8f9bbdb205311bc643aaf91d9d903a91204fd5b55ca949b85cdfa6fd00136',
  '08a30f5cd5cf8013ab70c1fa9e1109018c0337552296a8efe5c0cf543b284991',
  'f87e9494ea6151d140b742c1b88b4f435ae653559be641fddc2160cd24dd4e1b',
  'cb4307b016855c1a09d48bc8b3924a3080bd78b205963df3d6f20401d0486df9',
  'd25a8575b1c27ee725ff3a3ec6e1ba42aebd08ba545012c4807c072627c5dd4a',
  'f2be51c5290d2e61b47f10c379fa45d051a59a6b3f06d99174c2a170074bc8f5',
  '4c727aa110c9023371cfb364f3304ad9db22cdf2501208ef1e42e6ccc245b00f',
]);
const PRIOR_MEMORY: ReadonlySet<string> = new Set(['08795399635c8cdec2b50cb4e336f89ae880f3997ae52560ef647a9cdc8f1b08']);

interface ShippedSkill {
  name: string;
  file: string;
  prior: ReadonlySet<string>;
}

const METRO_SKILL: ShippedSkill = { name: RULES_SKILL, file: RULES_FILE, prior: PRIOR_METRO };
const STAGE_SKILL: ShippedSkill = { name: 'stage', file: 'STAGE.md', prior: PRIOR_STAGE };
const MEMORY_SKILL: ShippedSkill = { name: 'memory', file: 'MEMORY.md', prior: PRIOR_MEMORY };

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

export function placeFile(path: string, text: string, prior: ReadonlySet<string> = new Set()): Placed {
  if (!existsSync(path)) {
    writeHomeText(path, text, 0o644);
    return 'written';
  }
  const current = readFileSync(path, 'utf8');
  if (current === text || !prior.has(digest(current))) return 'present';
  writeHomeText(path, text, 0o644);
  return 'updated';
}

function readSettings(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function withPrivacy(settings: Record<string, unknown>, enabled: boolean): Record<string, unknown> {
  const current = isRecord(settings.env) ? settings.env : {};
  if (enabled)
    return { ...settings, env: { ...current, ...PRIVACY_ENV }, cleanupPeriodDays: settings.cleanupPeriodDays ?? RETENTION_DAYS };
  const env = Object.fromEntries(Object.entries(current).filter(([key]) => !(key in PRIVACY_ENV)));
  const rest = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'env'));
  return Object.keys(env).length === 0 ? rest : { ...rest, env };
}

function mergeSettings(dir: string, change: (settings: Record<string, unknown>) => Record<string, unknown>): SettingsOutcome {
  const path = join(dir, 'settings.json');
  const current = readSettings(path);
  if (current === null) return 'unreadable';
  const next = change(current);
  if (existsSync(path) && JSON.stringify(next) === JSON.stringify(current)) return 'unchanged';
  writeHomeText(path, `${JSON.stringify(next, null, 2)}\n`, existsSync(path) ? statSync(path).mode & 0o777 : 0o644);
  return 'written';
}

function applyPrivacy(dir: string, enabled: boolean): SettingsOutcome {
  return mergeSettings(dir, (current) => withPrivacy(current, enabled));
}

const skillPath = (dir: string, name: string): string => join(dir, 'skills', name, 'SKILL.md');
const workerPath = (dir: string): string => join(dir, 'agents', 'worker.md');

function placeSkill(dir: string, plugin: string, skill: ShippedSkill): Placed {
  const source = join(plugin, skill.file);
  if (!existsSync(source)) return 'missing';
  return placeFile(skillPath(dir, skill.name), readFileSync(source, 'utf8'), skill.prior);
}

function moveRenamedSkill(dir: string): void {
  const from = join(dir, 'skills', RENAMED_SKILL);
  const old = skillPath(dir, RENAMED_SKILL);
  if (!existsSync(old)) return;
  const shipped = PRIOR_METRO.has(digest(readFileSync(old, 'utf8')));
  if (existsSync(join(dir, 'skills', RULES_SKILL))) {
    if (shipped) removeHome(from, true);
    return;
  }
  moveHome(from, join(dir, 'skills', RULES_SKILL));
  log.info({ from, shipped }, 'claude-setup: moved the metro-orchestrator skill to metro');
  if (shipped) return;
  const path = skillPath(dir, RULES_SKILL);
  const text = readFileSync(path, 'utf8');
  const renamed = text.replace(RENAMED_NAME, `name: ${RULES_SKILL}`);
  if (renamed !== text) writeHomeText(path, renamed, statSync(path).mode & 0o777);
}

function tryMoveRenamedSkill(dir: string): void {
  try {
    moveRenamedSkill(dir);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'claude-setup: could not move the metro-orchestrator skill to metro');
  }
}

const written = (placed: Placed): boolean => placed === 'written' || placed === 'updated';

export function ensureClaudeSetup(deps: SetupDeps = {}): SetupReport {
  const dir = deps.dir ?? claudeDir();
  const agents = deps.agents ?? agentsDir();
  const privacy = privacyEnabled(agents);
  const plugin = deps.plugin ?? pluginDir(deps.env);
  tryMoveRenamedSkill(dir);
  const report: SetupReport = {
    privacy,
    guard: 'plugin',
    worker: placeFile(workerPath(dir), WORKER_AGENT, PRIOR_WORKER),
    skill: placeSkill(dir, plugin, METRO_SKILL),
    stage: placeSkill(dir, plugin, STAGE_SKILL),
    memory: placeSkill(dir, plugin, MEMORY_SKILL),
    settings: applyPrivacy(dir, privacy),
  };
  syncAvailableModelsQuietly({ ...deps, dir, agents });
  if ([report.worker, report.skill, report.stage, report.memory].some(written) || report.settings === 'written')
    log.info(report, 'claude-setup: applied the Claude Code setup for a metro box');
  if (report.settings === 'unreadable') log.warn({ path: join(dir, 'settings.json') }, 'claude-setup: settings.json is not valid JSON, so the privacy settings were not written');
  return report;
}

export function claudeSetupStatus(deps: SetupDeps = {}): SetupStatus {
  const dir = deps.dir ?? claudeDir();
  const agents = deps.agents ?? agentsDir();
  const settings = readSettings(join(dir, 'settings.json'));
  const env = settings !== null && isRecord(settings.env) ? settings.env : {};
  const days = settings?.cleanupPeriodDays;
  return {
    privacy: privacyEnabled(agents),
    permissionMode: permissionMode(agents),
    runner: harnessRunner(agents),
    runnerAllowed: sdkAllowed(agents),
    sdkOnLogin: sdkOnLogin(agents),
    systemPrompt: systemPrompt(agents),
    liveEvents: liveEvents(agents),
    memoryRoutine: memoryRoutine(agents),
    memoryJob: memoryJobStatus(),
    guard: 'plugin',
    worker: existsSync(workerPath(dir)),
    skill: existsSync(skillPath(dir, METRO_SKILL.name)),
    stage: existsSync(skillPath(dir, STAGE_SKILL.name)),
    memory: existsSync(skillPath(dir, MEMORY_SKILL.name)),
    privacyApplied: Object.keys(PRIVACY_ENV).every((key) => env[key] === '1'),
    retentionDays: typeof days === 'number' ? days : null,
  };
}

export function tryClaudeSetup(deps: SetupDeps = {}): void {
  try {
    ensureClaudeSetup(deps);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'claude-setup: could not apply the Claude Code setup');
  }
}

const MODELS_KEY = 'availableModels';
const ENFORCE_KEY = 'enforceAvailableModels';

export const routeOf = (cfg: ModelConfig): string | null => (routedConnection(cfg)?.provider === 'anthropic' ? null : runnerModel(cfg));

function withAvailableModels(settings: Record<string, unknown>, route: string | null, metroWrote: boolean): Record<string, unknown> {
  if (route !== null) return { ...settings, [MODELS_KEY]: [route], [ENFORCE_KEY]: true };
  if (!metroWrote) return settings;
  return Object.fromEntries(Object.entries(settings).filter(([key]) => key !== MODELS_KEY && key !== ENFORCE_KEY));
}

export function syncAvailableModels(cfg: ModelConfig, deps: SetupDeps = {}): SettingsOutcome {
  const dir = deps.dir ?? claudeDir();
  const agents = deps.agents ?? agentsDir();
  const route = routeOf(cfg);
  const metroWrote = readSetupState(agents).modelsByMetro === true;
  return mergeSettings(dir, (current) => {
    writeSetupState(agents, { modelsByMetro: route !== null });
    return withAvailableModels(current, route, metroWrote);
  });
}

export function syncAvailableModelsQuietly(deps: SetupDeps = {}, cfg?: ModelConfig): void {
  try {
    syncAvailableModels(cfg ?? readModelConfig(deps.agents ?? agentsDir()), deps);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'claude-setup: could not sync the model allowlist');
  }
}
