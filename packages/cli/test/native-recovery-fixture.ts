import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectDir } from '../src/background.ts';
import { nativeRecoveryArgs } from '../src/native-recovery.ts';
import { readNativeState } from '../src/native-recovery-state.ts';

export const OWNER = 'a96909bf-12d8-4061-b92d-703676659bcf';
export const NOW = Date.parse('2026-10-06T15:00:00.000Z');
export const PRIVATE = 'private prompt and tool output must never be copied';

export function row(type: string, content: unknown, at: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, uuid: randomUUID(), timestamp: new Date(at).toISOString(), message: { role: type, content }, ...fields };
}

export function call(tool: string, name = 'Agent', at = NOW - 100): Record<string, unknown> {
  return row('assistant', [{ type: 'tool_use', id: tool, name, input: { prompt: PRIVATE } }], at);
}

export function result(tool: string, outcome: Record<string, unknown>, at = NOW - 90, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return row('user', [{ type: 'tool_result', tool_use_id: tool, content: JSON.stringify({ ...outcome, prompt: PRIVATE }) }], at, fields);
}

export function notice(agent: string, status: string, at = NOW - 80, tool?: string, reason?: string): Record<string, unknown> {
  const text = `<task-notification><task-id>${agent}</task-id>${tool === undefined ? '' : `<tool-use-id>${tool}</tool-use-id>`}<status>${status}</status>${reason === undefined ? '' : `<reason>${reason}</reason>`}<summary>${PRIVATE}</summary></task-notification>`;
  return row('user', text, at, { origin: { kind: 'task-notification', producer: 'session-task' }, promptSource: 'system', isSidechain: false });
}

export function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'metro-native-recovery-'));
  const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') };
  const project = projectDir(env.CLAUDE_CONFIG_DIR, home);
  const root = join(project, `${OWNER}.jsonl`);
  const statePath = join(home, '.metro', 'native-recovery', `${OWNER}.json`);
  mkdirSync(project, { recursive: true });
  writeFileSync(root, '');
  const file = (agent?: string): string => agent === undefined ? root : join(project, OWNER, 'subagents', `agent-${agent}.jsonl`);
  const write = (rows: unknown[], agent?: string): void => {
    mkdirSync(dirname(file(agent)), { recursive: true });
    writeFileSync(file(agent), rows.length === 0 ? '' : `${rows.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  };
  const append = (rows: unknown[], agent?: string): void => appendFileSync(file(agent), `${rows.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  const run = (now = NOW, args = ['--resume', OWNER]): string[] => nativeRecoveryArgs(args, { env, cwd: home, now });
  const read = () => readNativeState(statePath, OWNER);
  return { home, env, project, root, statePath, file, write, append, run, read };
}

export type Fixture = ReturnType<typeof fixture>;
