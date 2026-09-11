import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PLUGIN = join(import.meta.dir, '..', '..', '..', 'plugin');
const GUARD = join(PLUGIN, 'bin', 'guard.mjs');
const START = join(PLUGIN, 'bin', 'session-start.mjs');

function guard(payload: unknown): string {
  const run = spawnSync('node', [GUARD], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8' });
  if (run.stdout.trim() === '') return 'allow';
  const out = JSON.parse(run.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  return `${out.hookSpecificOutput.permissionDecision}: ${out.hookSpecificOutput.permissionDecisionReason.slice(0, 40)}`;
}

describe('the orchestrator guard the plugin ships', () => {
  test('the main thread may delegate, talk over any MCP server, schedule, and look at images; nothing else', () => {
    expect(guard({ tool_name: 'Agent', tool_input: {} })).toBe('allow');
    expect(guard({ tool_name: 'Workflow', tool_input: {} })).toBe('allow');
    expect(guard({ tool_name: 'mcp__metro__send', tool_input: {} })).toBe('allow');
    expect(guard({ tool_name: 'mcp__plugin_metro_zapier__run', tool_input: {} })).toBe('allow');
    expect(guard({ tool_name: 'ToolSearch', tool_input: {} })).toBe('allow');
    expect(guard({ tool_name: 'ScheduleWakeup', tool_input: {} })).toBe('allow');
    expect(guard({ tool_name: 'Read', tool_input: { file_path: '/x/shot.PNG' } })).toBe('allow');
    expect(guard({ tool_name: 'Read', tool_input: { file_path: '/x/notes.md' } })).toMatch(/^deny: The main thread is orchestrator-only/);
    expect(guard({ tool_name: 'Read', tool_input: { file_path: '/x/doc.svg' } })).toMatch(/^deny/);
    expect(guard({ tool_name: 'Bash', tool_input: { command: 'echo hi' } })).toMatch(/^deny: The main thread is orchestrator-only/);
    expect(guard({ tool_name: 'WebFetch', tool_input: {} })).toMatch(/^deny/);
  });

  test('a foreground subagent is refused on the main thread, a background one is not', () => {
    expect(guard({ tool_name: 'Agent', tool_input: { run_in_background: false } })).toMatch(/^deny: A foreground subagent blinds/);
    expect(guard({ tool_name: 'Agent', tool_input: { run_in_background: true } })).toBe('allow');
  });

  test('subagents keep every tool, except the ones that wait on the terminal, which nobody may use', () => {
    expect(guard({ tool_name: 'Bash', agent_id: 'a1', tool_input: {} })).toBe('allow');
    expect(guard({ tool_name: 'Write', agent_id: 'a1', tool_input: {} })).toBe('allow');
    for (const tool of ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']) {
      expect(guard({ tool_name: tool, agent_id: 'a1', tool_input: {} })).toMatch(/^deny: .* blocks the session/);
      expect(guard({ tool_name: tool, tool_input: {} })).toMatch(/^deny: .* blocks the session/);
    }
  });

  test('a payload that does not parse is denied, never allowed', () => {
    expect(guard('not json')).toMatch(/^deny/);
    expect(guard('')).toMatch(/^deny/);
  });
});

describe('the standing rules the plugin loads at session start', () => {
  test('come from the metro-orchestrator skill on the machine, else from the copy the plugin carries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-guard-'));
    try {
      const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
      const fallback = spawnSync('node', [START], { encoding: 'utf8', env });
      const out = JSON.parse(fallback.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
      expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(out.hookSpecificOutput.additionalContext).toContain('orchestrator');
      expect(out.hookSpecificOutput.additionalContext).not.toContain('---\nname:');
      mkdirSync(join(dir, 'skills', 'metro-orchestrator'), { recursive: true });
      writeFileSync(join(dir, 'skills', 'metro-orchestrator', 'SKILL.md'), '---\nname: metro-orchestrator\n---\nAnswer in French.\n');
      const own = spawnSync('node', [START], { encoding: 'utf8', env });
      const text = (JSON.parse(own.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
      expect(text).toContain('Answer in French.');
      expect(text).not.toContain('name: metro-orchestrator');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
