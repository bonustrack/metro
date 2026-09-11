import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { readJson, writeJson } from '@metro-labs/core/secure-fs';
import { agentsDir } from '../agents/files.js';
import { claudeDir } from './files.js';
import { stagedMarketplaceDir } from './plugin-install.js';

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

export const WORKER_AGENT = `---
name: worker
description: Default execution agent for delegated work. Full tool access and maximum reasoning effort. Use for any substantive task the orchestrator main thread cannot perform itself - reading and writing code, running commands, research, analysis.
effort: xhigh
---

You are a worker agent. The main thread that dispatched you is an orchestrator with no file, shell or network access; it can only delegate and relay messages. That means you are where the actual work happens, and the quality of your output is the quality of the result.

Work to completion. Do not hand back a partial answer with a suggestion that someone else finish it; there is no one else. If part of the task is genuinely blocked, complete every other part in full and say plainly what you left undone and why.

Never call AskUserQuestion or ExitPlanMode. They are blocked by policy, because nobody is watching the terminal around the clock and a blocking prompt stalls indefinitely. When you hit an ambiguity: do everything that does not depend on it, then choose the most reasonable interpretation, state the assumption explicitly in your report, and continue.

Your final message is a report to the orchestrator, not a message to a human. It gets relayed onward, so make it self-contained and concise. Lead with the outcome. Include concrete evidence, command output, file paths with line numbers, test results, for anything you claim to have verified. Report failures faithfully: if a test failed, say so and show the output; if you skipped a step, say that too.
`;

export interface SetupDeps {
  dir?: string;
  agents?: string;
  guidance?: string;
  env?: NodeJS.ProcessEnv;
}

export type Placed = 'written' | 'present' | 'missing';
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
  guard: 'plugin';
  worker: boolean;
  skill: boolean;
  privacyApplied: boolean;
  retentionDays: number | null;
}

const statePath = (agents: string): string => join(agents, STATE_FILE);

export function privacyEnabled(agents = agentsDir()): boolean {
  const raw = readJson<unknown>(statePath(agents), null);
  return !isRecord(raw) || raw.privacy !== false;
}

export function setPrivacy(enabled: boolean, agents = agentsDir()): void {
  writeJson(statePath(agents), { privacy: enabled });
}

export function guidancePath(env: NodeJS.ProcessEnv = process.env): string {
  const staged = stagedMarketplaceDir(env);
  if (staged !== null) {
    const path = join(staged, 'plugin', GUIDANCE);
    if (existsSync(path)) return path;
  }
  return fileURLToPath(new URL(`../../../../plugin/${GUIDANCE}`, import.meta.url));
}

function ensureFile(path: string, text: string): Placed {
  if (existsSync(path)) return 'present';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o644 });
  return 'written';
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

export function applyPrivacy(dir: string, enabled: boolean): SettingsOutcome {
  const path = join(dir, 'settings.json');
  const current = readSettings(path);
  if (current === null) return 'unreadable';
  const next = withPrivacy(current, enabled);
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return 'unchanged';
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.metro-${String(process.pid)}.tmp`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, path);
  return 'written';
}

const skillPath = (dir: string): string => join(dir, 'skills', SKILL_NAME, 'SKILL.md');
const workerPath = (dir: string): string => join(dir, 'agents', 'worker.md');

function placeSkill(dir: string, guidance: string): Placed {
  if (!existsSync(guidance)) return 'missing';
  return ensureFile(skillPath(dir), readFileSync(guidance, 'utf8'));
}

export function ensureClaudeSetup(deps: SetupDeps = {}): SetupReport {
  const dir = deps.dir ?? claudeDir();
  const agents = deps.agents ?? agentsDir();
  const privacy = privacyEnabled(agents);
  const report: SetupReport = {
    privacy,
    guard: 'plugin',
    worker: ensureFile(workerPath(dir), WORKER_AGENT),
    skill: placeSkill(dir, deps.guidance ?? guidancePath(deps.env)),
    settings: applyPrivacy(dir, privacy),
  };
  if (report.worker === 'written' || report.skill === 'written' || report.settings === 'written')
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
