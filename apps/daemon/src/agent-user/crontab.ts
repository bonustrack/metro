import { crontabOf, type Runner } from './schedules.js';
import type { AgentUser } from './user.js';

export function withBlock(lines: string[], begin: string, end: string, block: string[], at: 'top' | 'end'): string[] {
  const start = lines.indexOf(begin);
  const stop = lines.indexOf(end);
  const rest = start >= 0 && stop > start ? [...lines.slice(0, start), ...lines.slice(stop + 1)] : lines;
  const kept = rest.filter((l) => l !== '');
  if (block.length === 0) return kept;
  const wrapped = [begin, ...block, end];
  return at === 'top' ? [...wrapped, ...kept] : [...kept, ...wrapped];
}

export function editCrontab(user: AgentUser, runner: Runner, change: (lines: string[]) => string[]): boolean {
  const lines = crontabOf(runner, user.name);
  const next = change(lines);
  if (next.join('\n') === lines.filter((l) => l !== '').join('\n')) return false;
  runner.run('crontab', ['-u', user.name, '-'], next.length === 0 ? '' : `${next.join('\n')}\n`);
  return true;
}
