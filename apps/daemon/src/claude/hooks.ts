import { join } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';
import { GUARD_HOOK, SESSION_START_HOOK } from './cli-files.js';

interface HookCommand {
  type: 'command';
  command: string;
  statusMessage?: string;
}

const METRO_COMMAND = /^node "[^"]*\/hooks\/(guard|session-start)\.mjs"$/;
const METRO_GUARD = /^node "[^"]*\/hooks\/guard\.mjs"$/;

const commandOf = (hook: unknown): string => (isRecord(hook) && typeof hook.command === 'string' ? hook.command : '');
const metroHook = (hook: unknown): boolean => METRO_COMMAND.test(commandOf(hook));
const run = (dir: string, file: string): string => `node "${join(dir, file)}"`;

function metroHooks(dir: string): Record<string, HookCommand> {
  return {
    PreToolUse: { type: 'command', command: run(dir, GUARD_HOOK), statusMessage: 'Checking the orchestrator boundary' },
    SessionStart: { type: 'command', command: run(dir, SESSION_START_HOOK) },
  };
}

function withHook(groups: unknown[], wanted: HookCommand): unknown[] {
  let placed = false;
  const out: unknown[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks) || !group.hooks.some(metroHook)) {
      out.push(group);
      continue;
    }
    const kept = group.hooks.flatMap((hook: unknown) => {
      if (!metroHook(hook)) return [hook];
      if (placed) return [];
      placed = true;
      return [wanted];
    });
    if (kept.length > 0) out.push({ ...group, hooks: kept });
  }
  return placed ? out : [...out, { hooks: [wanted] }];
}

export function withMetroHooks(settings: Record<string, unknown>, dir: string): Record<string, unknown> | null {
  const hooks = settings.hooks ?? {};
  if (!isRecord(hooks)) return null;
  const next: Record<string, unknown> = { ...hooks };
  for (const [event, wanted] of Object.entries(metroHooks(dir))) {
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups)) return null;
    next[event] = withHook(groups, wanted);
  }
  return { ...settings, hooks: next };
}

export function hasMetroGuard(settings: Record<string, unknown> | null): boolean {
  const groups = settings !== null && isRecord(settings.hooks) ? settings.hooks.PreToolUse : undefined;
  if (!Array.isArray(groups)) return false;
  return groups.some((group) => isRecord(group) && Array.isArray(group.hooks) && group.hooks.some((hook) => METRO_GUARD.test(commandOf(hook))));
}
