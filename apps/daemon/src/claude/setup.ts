import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { readJson, writeAtomic, writeJson } from '@metro-labs/core/secure-fs';
import { agentsDir } from '../agents/files.js';
import { claudeDir } from './files.js';
import { stagedMarketplaceDir } from './plugin-install.js';
import { readModelConfig, routedConnection, type ModelConfig } from '../gateway/model-config.js';

export const PRIVACY_ENV: Record<string, string> = {
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF: '1',
};
export const RETENTION_DAYS = 7;
export const SKILL_NAME = 'metro-orchestrator';
const STATE_FILE = 'claude-setup.json';
const GUIDANCE = 'orchestrator.md';
export const SYSTEM_PROMPT_FILE = 'system-prompt.md';
export const SYSTEM_PROMPT_MAX = 64 * 1024;

export const WORKER_AGENT = `---
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
  guidance?: string;
  env?: NodeJS.ProcessEnv;
}

export type Placed = 'written' | 'present' | 'updated' | 'missing';
export type SettingsOutcome = 'written' | 'unchanged' | 'unreadable';

export interface SetupReport {
  privacy: boolean;
  guard: 'plugin';
  worker: Placed;
  skill: Placed;
  settings: SettingsOutcome;
}

export interface SetupStatus {
  privacy: boolean;
  permissionMode: PermissionMode;
  systemPrompt: string;
  guard: 'plugin';
  worker: boolean;
  skill: boolean;
  privacyApplied: boolean;
  retentionDays: number | null;
}

const statePath = (agents: string): string => join(agents, STATE_FILE);

export const PERMISSION_MODES = ['auto', 'bypass'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

function readState(agents: string): Record<string, unknown> {
  const raw = readJson<unknown>(statePath(agents), null);
  return isRecord(raw) ? raw : {};
}

function writeState(agents: string, patch: Record<string, unknown>): void {
  mkdirSync(agents, { recursive: true });
  writeJson(statePath(agents), { ...readState(agents), ...patch });
}

export const privacyEnabled = (agents = agentsDir()): boolean => readState(agents).privacy !== false;

export function setPrivacy(enabled: boolean, agents = agentsDir()): void {
  writeState(agents, { privacy: enabled });
}

export const isPermissionMode = (value: unknown): value is PermissionMode => PERMISSION_MODES.some((m) => m === value);

export function permissionMode(agents = agentsDir()): PermissionMode {
  const mode = readState(agents).permissionMode;
  return isPermissionMode(mode) ? mode : 'auto';
}

export function setPermissionMode(mode: PermissionMode, agents = agentsDir()): void {
  writeState(agents, { permissionMode: mode });
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

export function guidancePath(env: NodeJS.ProcessEnv = process.env): string {
  const staged = stagedMarketplaceDir(env);
  if (staged !== null) {
    const path = join(staged, 'plugin', GUIDANCE);
    if (existsSync(path)) return path;
  }
  return fileURLToPath(new URL(`../../../../plugin/${GUIDANCE}`, import.meta.url));
}

const PRIOR_WORKER: ReadonlySet<string> = new Set(['08a0cd8710df285d6512245246bb8b658b7cfc7f3e89490514ee5376779eb2ef']);
const PRIOR_SKILL: ReadonlySet<string> = new Set([
  '0b3d122ed95beff09d579cf912cd4238e1db524c41fce4b314de57d6ff5908ad',
  '36f4fb57f231a119d717b5e3d6ccb654f94960fcca708683f376679aead8df25',
]);

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

export function placeFile(path: string, text: string, prior: ReadonlySet<string> = new Set()): Placed {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { mode: 0o644 });
    return 'written';
  }
  const current = readFileSync(path, 'utf8');
  if (current === text || !prior.has(digest(current))) return 'present';
  writeFileSync(path, text, { mode: 0o644 });
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
  writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return 'written';
}

export function applyPrivacy(dir: string, enabled: boolean): SettingsOutcome {
  return mergeSettings(dir, (current) => withPrivacy(current, enabled));
}

const skillPath = (dir: string): string => join(dir, 'skills', SKILL_NAME, 'SKILL.md');
const workerPath = (dir: string): string => join(dir, 'agents', 'worker.md');

function placeSkill(dir: string, guidance: string): Placed {
  if (!existsSync(guidance)) return 'missing';
  return placeFile(skillPath(dir), readFileSync(guidance, 'utf8'), PRIOR_SKILL);
}

const written = (placed: Placed): boolean => placed === 'written' || placed === 'updated';

export function ensureClaudeSetup(deps: SetupDeps = {}): SetupReport {
  const dir = deps.dir ?? claudeDir();
  const agents = deps.agents ?? agentsDir();
  const privacy = privacyEnabled(agents);
  const report: SetupReport = {
    privacy,
    guard: 'plugin',
    worker: placeFile(workerPath(dir), WORKER_AGENT, PRIOR_WORKER),
    skill: placeSkill(dir, deps.guidance ?? guidancePath(deps.env)),
    settings: applyPrivacy(dir, privacy),
  };
  syncAvailableModelsQuietly({ ...deps, dir, agents });
  if (written(report.worker) || written(report.skill) || report.settings === 'written')
    log.info(report, 'claude-setup: applied the Claude Code setup for a metro box');
  if (report.settings === 'unreadable') log.warn({ path: join(dir, 'settings.json') }, 'claude-setup: settings.json is not valid JSON, so the privacy settings were not written');
  return report;
}

export function claudeSetupStatus(deps: SetupDeps = {}): SetupStatus {
  const dir = deps.dir ?? claudeDir();
  const settings = readSettings(join(dir, 'settings.json'));
  const env = settings !== null && isRecord(settings.env) ? settings.env : {};
  const days = settings?.cleanupPeriodDays;
  return {
    privacy: privacyEnabled(deps.agents ?? agentsDir()),
    permissionMode: permissionMode(deps.agents ?? agentsDir()),
    systemPrompt: systemPrompt(deps.agents ?? agentsDir()),
    guard: 'plugin',
    worker: existsSync(workerPath(dir)),
    skill: existsSync(skillPath(dir)),
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

export function routeOf(cfg: ModelConfig): string | null {
  const conn = routedConnection(cfg);
  if (conn === null || conn.provider === 'anthropic' || conn.model === '') return null;
  return `${conn.provider}:${conn.model}`;
}

function withAvailableModels(settings: Record<string, unknown>, route: string | null, metroWrote: boolean): Record<string, unknown> {
  if (route !== null) return { ...settings, [MODELS_KEY]: [route], [ENFORCE_KEY]: true };
  if (!metroWrote) return settings;
  return Object.fromEntries(Object.entries(settings).filter(([key]) => key !== MODELS_KEY && key !== ENFORCE_KEY));
}

export function syncAvailableModels(cfg: ModelConfig, deps: SetupDeps = {}): SettingsOutcome {
  const dir = deps.dir ?? claudeDir();
  const agents = deps.agents ?? agentsDir();
  const route = routeOf(cfg);
  const state = readJson<unknown>(statePath(agents), null);
  const metroWrote = isRecord(state) && state.modelsByMetro === true;
  return mergeSettings(dir, (current) => {
    mkdirSync(agents, { recursive: true });
    writeJson(statePath(agents), { ...(isRecord(state) ? state : {}), modelsByMetro: route !== null });
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
