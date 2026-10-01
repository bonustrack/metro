import type { Runner } from './schedules.js';
import type { AgentUser } from './user.js';

const NO_CRONTAB = /no crontab for/i;

const indexesOf = (lines: string[], marker: string): number[] => lines.flatMap((l, i) => (l === marker ? [i] : []));

function outsideBlock(lines: string[], begin: string, end: string): string[] {
  const starts = indexesOf(lines, begin);
  const stops = indexesOf(lines, end);
  const [start = -1] = starts;
  const [stop = -1] = stops;
  if (starts.length !== 1 || stops.length !== 1 || stop < start) return lines;
  return [...lines.slice(0, start), ...lines.slice(stop + 1)];
}

export function withBlock(lines: string[], begin: string, end: string, block: string[], at: 'top' | 'end', owned: (line: string) => boolean = () => false): string[] {
  const kept = outsideBlock(lines, begin, end).filter((l) => l !== '' && l !== begin && l !== end && !owned(l));
  if (block.length === 0) return kept;
  const wrapped = [begin, ...block, end];
  return at === 'top' ? [...wrapped, ...kept] : [...kept, ...wrapped];
}

const failure = (what: string, user: AgentUser, out: { status: number | null; stderr?: string }): Error =>
  new Error(`could not ${what} the crontab of ${user.name}: ${(out.stderr ?? '').trim() || `exit ${String(out.status)}`}`);

export function readCrontab(user: AgentUser, runner: Runner): string[] {
  const out = runner.run('crontab', ['-l', '-u', user.name]);
  if (out.status === 0) return out.stdout.split('\n');
  if (out.status === 1 && NO_CRONTAB.test(out.stderr ?? '')) return [];
  throw failure('read', user, out);
}

export function writeCrontab(user: AgentUser, runner: Runner, lines: string[], next: string[]): boolean {
  if (next.join('\n') === lines.filter((l) => l !== '').join('\n')) return false;
  const out = runner.run('crontab', ['-u', user.name, '-'], next.length === 0 ? '' : `${next.join('\n')}\n`);
  if (out.status !== 0) throw failure('write', user, out);
  return true;
}

export function editCrontab(user: AgentUser, runner: Runner, change: (lines: string[]) => string[]): boolean {
  const lines = readCrontab(user, runner);
  return writeCrontab(user, runner, lines, change(lines));
}
