import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunState } from '../db/schema.js';
import { runLabel } from './label.js';
import { summarizeTranscript, type TranscriptSummary } from './transcript.js';

export interface CollectedRun {
  runId: string;
  agentType: string | null;
  label: string | null;
  state: RunState;
  startedAt: string;
  endedAt: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  fingerprint: string;
}

export interface CollectPaths {
  projects: string;
  workspaces: string;
}

const RUN_FILE_RE = /^agent-([a-z0-9][a-z0-9_-]{0,63})\.jsonl$/;
const RUN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/;

export function collectPathsFromEnv(): CollectPaths {
  return {
    projects:
      process.env.METRO_RUNS_PROJECTS_DIR ??
      join(homedir(), '.claude', 'projects'),
    workspaces:
      process.env.METRO_RUNS_WORKSPACES_DIR ??
      join(homedir(), 'work', 'agents'),
  };
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function files(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function agentType(raw: unknown): string | null {
  return typeof raw === 'string' && TYPE_RE.test(raw) ? raw : null;
}

export interface TranscriptRef {
  runId: string;
  path: string;
  metaPath: string;
}

export function transcriptRefs(projects: string): TranscriptRef[] {
  const found: TranscriptRef[] = [];
  for (const project of entries(projects))
    for (const session of entries(join(projects, project))) {
      const dir = join(projects, project, session, 'subagents');
      for (const name of files(dir)) {
        const runId = RUN_FILE_RE.exec(name)?.[1];
        if (runId === undefined) continue;
        found.push({
          runId,
          path: join(dir, name),
          metaPath: join(dir, `agent-${runId}.meta.json`),
        });
      }
    }
  return found;
}

function procStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function ownerAlive(meta: Record<string, unknown>): boolean {
  const pid = meta.owner_pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  if (!pidExists(pid)) return false;
  const live = procStartTime(pid);
  const recorded = meta.owner_pid_start;
  if (live === null || typeof recorded !== 'string' || recorded === '') return true;
  return recorded === live;
}

interface Live {
  agentType: string | null;
  startedAt: string | null;
  alive: boolean;
}

export function liveWorkspaces(workspaces: string): Map<string, Live> {
  const live = new Map<string, Live>();
  for (const name of entries(workspaces)) {
    if (!RUN_ID_RE.test(name)) continue;
    const meta = readJson(join(workspaces, name, '.agent-meta.json'));
    if (meta === null) continue;
    live.set(name, {
      agentType: agentType(meta.agent_type),
      startedAt: typeof meta.started_at === 'string' ? meta.started_at : null,
      alive: ownerAlive(meta),
    });
  }
  return live;
}

function stateOf(summary: TranscriptSummary | null, live: Live | undefined): RunState {
  if (summary?.finished === true) return 'done';
  if (live?.alive === true) return 'running';
  return 'lost';
}

function fingerprintOf(path: string | null, state: RunState): string {
  if (path === null) return `none:${state}`;
  try {
    const stat = statSync(path);
    return `${stat.size}:${Math.round(stat.mtimeMs)}:${state}`;
  } catch {
    return `gone:${state}`;
  }
}

function readTranscript(path: string): TranscriptSummary | null {
  try {
    return summarizeTranscript(readFileSync(path, 'utf8').split('\n'));
  } catch {
    return null;
  }
}

interface Sources {
  summary: TranscriptSummary | null;
  meta: Record<string, unknown> | null;
}

function readSources(ref: TranscriptRef | undefined): Sources {
  if (ref === undefined) return { summary: null, meta: null };
  return { summary: readTranscript(ref.path), meta: readJson(ref.metaPath) };
}

function startOf(
  summary: TranscriptSummary | null,
  live: Live | undefined,
): string | null {
  const own = summary === null ? null : summary.startedAt;
  if (own !== null) return own;
  return live === undefined ? null : live.startedAt;
}

function typeOf(
  meta: Record<string, unknown> | null,
  live: Live | undefined,
): string | null {
  const declared = meta === null ? null : agentType(meta.agentType);
  if (declared !== null) return declared;
  return live === undefined ? null : live.agentType;
}

function endOf(
  state: RunState,
  summary: TranscriptSummary | null,
): string | null {
  if (state === 'running' || summary === null) return null;
  return summary.endedAt;
}

interface Counters {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const NO_COUNTERS: Counters = {
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function counters(summary: TranscriptSummary | null): Counters {
  if (summary === null) return NO_COUNTERS;
  const { turns, inputTokens, outputTokens } = summary;
  const { cacheReadTokens, cacheWriteTokens } = summary;
  return {
    turns,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

function buildRun(
  runId: string,
  ref: TranscriptRef | undefined,
  live: Live | undefined,
): CollectedRun | null {
  const { summary, meta } = readSources(ref);
  const state = stateOf(summary, live);
  const startedAt = startOf(summary, live);
  if (startedAt === null) return null;
  return {
    runId,
    agentType: typeOf(meta, live),
    label: meta === null ? null : runLabel(meta.description),
    state,
    startedAt,
    endedAt: endOf(state, summary),
    ...counters(summary),
    fingerprint: fingerprintOf(ref === undefined ? null : ref.path, state),
  };
}

export function collectRuns(paths: CollectPaths): CollectedRun[] {
  const refs = new Map(transcriptRefs(paths.projects).map((r) => [r.runId, r]));
  const live = liveWorkspaces(paths.workspaces);
  const runs: CollectedRun[] = [];
  for (const runId of new Set([...refs.keys(), ...live.keys()])) {
    const run = buildRun(runId, refs.get(runId), live.get(runId));
    if (run !== null) runs.push(run);
  }
  return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
