import { SETUP_STEPS, type SetupStep } from './user-data.js';

export const SETUP_START = 'metro setup: start';
export const SETUP_DONE = 'metro setup: done';
const TAIL_LINES = 80;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Z0-9]|\r/g;
const KERNEL_STAMP = /^\[\s*\d+\.\d+\]\s*/;
const CLOUD_INIT = /^cloud-init\[\d+\]:\s?/;

export interface BootLog {
  lines: string[];
  started: boolean;
  done: boolean;
}

function tidy(line: string): string {
  return line.replace(ANSI, '').replace(KERNEL_STAMP, '').replace(CLOUD_INIT, '').trimEnd();
}

export function metroSetupLines(text: string): BootLog {
  const all = text.split('\n').map(tidy).filter((l) => l.trim() !== '');
  const startAt = all.map((l) => l.includes(SETUP_START)).lastIndexOf(true);
  const started = startAt !== -1;
  const from = started ? all.slice(startAt) : all.slice(-TAIL_LINES);
  const lines = from.length > TAIL_LINES ? from.slice(-TAIL_LINES) : from;
  return { lines, started, done: from.some((l) => l.includes(SETUP_DONE)) };
}

export const STEP_LABELS: Record<SetupStep, string> = {
  packages: 'System packages',
  node: 'Node.js 22',
  bun: 'bun',
  claude: 'Claude Code',
  tailscale: 'Tailscale joined',
  metro: 'Metro installed',
  service: 'Metro service started',
};

export type StepState = 'pending' | 'active' | 'done' | 'failed';

export interface Progress {
  steps: { key: SetupStep; label: string; state: StepState }[];
  failed: boolean;
  finished: boolean;
}

const FAILED = 'Failed to run module scripts_user';
const STEP_MARK = /metro setup: step ([a-z]+)/;

function reachedStep(lines: string[]): number {
  let reached = -1;
  for (const line of lines) {
    const key = STEP_MARK.exec(line)?.[1];
    const at = SETUP_STEPS.indexOf(key as SetupStep);
    if (at > reached) reached = at;
  }
  return reached;
}

export function progressOf(log: BootLog): Progress {
  const reached = reachedStep(log.lines);
  const failed = !log.done && log.lines.some((l) => l.includes(FAILED));
  const steps = SETUP_STEPS.map((key, at) => {
    const state: StepState = log.done || at < reached ? 'done' : at === reached ? (failed ? 'failed' : 'active') : 'pending';
    return { key, label: STEP_LABELS[key], state };
  });
  return { steps, failed, finished: log.done };
}
