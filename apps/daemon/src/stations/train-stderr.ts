import { isRecord } from '@metro-labs/core/is-record';

export type TrainLevel = 'error' | 'warn' | 'info' | 'debug';

export interface TrainLogLine {
  level: TrainLevel;
  msg: string;
  fields: Record<string, unknown>;
}

const PROBLEM = /\b(error|errored|fail|failed|failure|refused|denied|disconnected|logged out|re-pair|timed out|timeout|cannot|could not|invalid|unexpected|exception|warn|warning)\b/i;
const PINO_OWN = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'name', 'v']);

const levelOf = (value: number): TrainLevel => (value >= 50 ? 'error' : value >= 40 ? 'warn' : value >= 30 ? 'info' : 'debug');

function pinoLine(line: string): TrainLogLine | null {
  if (!line.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.level !== 'number' || typeof parsed.msg !== 'string') return null;
  const fields = Object.fromEntries(Object.entries(parsed).filter(([key]) => !PINO_OWN.has(key)));
  return { level: levelOf(parsed.level), msg: parsed.msg, fields };
}

export function trainLogLine(line: string): TrainLogLine {
  return pinoLine(line) ?? { level: PROBLEM.test(line) ? 'warn' : 'info', msg: line, fields: {} };
}
