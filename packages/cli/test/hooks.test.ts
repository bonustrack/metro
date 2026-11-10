import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOKS = join(import.meta.dir, '..', 'hooks');
const GUARD = join(HOOKS, 'guard.mjs');
const START = join(HOOKS, 'session-start.mjs');

const EMPTY = mkdtempSync(join(tmpdir(), 'metro-guard-empty-'));

function guard(payload: unknown, agentsDir = EMPTY, session?: string): string {
  const run = spawnSync('node', [GUARD], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, METRO_AGENTS_DIR: agentsDir, ...(session === undefined ? {} : { METRO_SESSION: session }) },
  });
  if (run.stdout.trim() === '') return 'allow';
  const out = JSON.parse(run.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  return `${out.hookSpecificOutput.permissionDecision}: ${out.hookSpecificOutput.permissionDecisionReason.slice(0, 40)}`;
}

describe('the orchestrator guard the CLI ships', () => {
  test('the main thread may delegate, talk over metro, schedule, and look at images; nothing else', () => {
    expect(guard({ tool_name: 'Agent', tool_input: {} })).toBe('allow');
    expect(guard({ tool_name: 'Workflow', tool_input: {} })).toBe('allow');
    expect(guard({ tool_name: 'mcp__metro__send', tool_input: {} })).toBe('allow');
    expect(guard({ tool_name: 'mcp__zapier__run', tool_input: {} })).toContain('connector');
    expect(guard({ tool_name: 'mcp__zapier__run', tool_input: {}, agent_id: 'sub' })).toBe('allow');
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

  test('connectors: tool_search runs on any thread, tool_call only in a worker', () => {
    expect(guard({ tool_name: 'mcp__metro__tool_search', tool_input: { query: 'notion page' } })).toBe('allow');
    expect(guard({ tool_name: 'mcp__metro__tool_search', tool_input: { query: 'notion page' }, agent_id: 'w1' })).toBe('allow');
    expect(guard({ tool_name: 'mcp__metro__tool_call', tool_input: { calls: [] } })).toMatch(/^deny: A connector call is work, not orches/);
    expect(guard({ tool_name: 'mcp__metro__tool_call', tool_input: { calls: [{ tool: 'notion.update_page' }] }, agent_id: 'w1' })).toBe('allow');
    for (const old of ['mcp__mcp__find_tools', 'mcp__plugin_metro_mcp__find_tools', 'mcp__notion__update_page'])
      expect(guard({ tool_name: old, tool_input: { query: 'notion page' } })).toMatch(/^deny: A connector call is work, not orches/);
    expect(guard({ tool_name: 'mcp__notion__update_page', tool_input: {}, agent_id: 'w1' })).toBe('allow');
  });

  test('a payload that does not parse is denied, never allowed', () => {
    expect(guard('not json')).toMatch(/^deny/);
    expect(guard('')).toMatch(/^deny/);
  });
});

const LINE = 'metro://telegram/tg000000001/-100555';

describe('the owner rules are the daemon\'s alone', () => {
  test('the hooks ship no copy of them, and a snapshot an older Metro left behind changes nothing', () => {
    expect(readdirSync(HOOKS).sort()).toEqual(['guard.mjs', 'session-start.mjs']);
    expect(readFileSync(GUARD, 'utf8')).not.toContain('policy');
    const dir = mkdtempSync(join(tmpdir(), 'metro-guard-policy-'));
    writeFileSync(join(dir, 'policy.json'), JSON.stringify({ version: 1, tools: { send: 'write', delete: 'write' }, accounts: { 'telegram/tg000000001': { write: 'ask', tools: { delete: 'deny' } } }, stations: { telegram: ['tg000000001'] } }));
    for (const tool of ['send', 'delete']) {
      expect(guard({ tool_name: `mcp__metro__${tool}`, tool_input: { line: LINE, text: 'hi', message_id: 'm1' } }, dir)).toBe('allow');
      expect(guard({ tool_name: `mcp__metro__${tool}`, tool_input: { line: LINE, text: 'hi', message_id: 'm1' }, agent_id: 'w1' }, dir)).toBe('allow');
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('a session still marked METRO_SESSION=voice', () => {
  test('gets the chat rules: the voice brain is gone, so the marker relaxes nothing', () => {
    expect(guard({ tool_name: 'Bash', tool_input: { command: 'ls' } }, EMPTY, 'voice')).toMatch(/^deny: The main thread is orchestrator-only/);
    expect(guard({ tool_name: 'mcp__metro__tool_call', tool_input: { calls: [] } }, EMPTY, 'voice')).toMatch(/^deny: A connector call is work, not orches/);
    expect(guard({ tool_name: 'Agent', tool_input: { run_in_background: false } }, EMPTY, 'voice')).toMatch(/^deny: A foreground subagent blinds/);
    const run = spawnSync('node', [START], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: EMPTY, METRO_SESSION: 'voice' } });
    expect(run.stdout).toContain('Standing rules');
  });
});

describe('the guard and the standing rules in the memory routine (METRO_SESSION=memory)', () => {
  test('stand aside: the routine reads and edits memory files on its own main thread, as it did with the plugin off', () => {
    for (const payload of [{ tool_name: 'Read', tool_input: { file_path: '/x/notes.md' } }, { tool_name: 'Edit', tool_input: {} }, { tool_name: 'mcp__metro__delete', tool_input: { line: LINE } }])
      expect(guard(payload, EMPTY, 'memory')).toBe('allow');
    const run = spawnSync('node', [START], { encoding: 'utf8', env: { ...process.env, METRO_SESSION: 'memory' } });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('');
  });
});

describe('the standing rules loaded at session start', () => {
  test('come from the metro skill on the machine, else from the copy the CLI carries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-guard-'));
    try {
      const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
      const fallback = spawnSync('node', [START], { encoding: 'utf8', env });
      const out = JSON.parse(fallback.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
      expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(out.hookSpecificOutput.additionalContext).toContain('orchestrator');
      expect(out.hookSpecificOutput.additionalContext).not.toContain('---\nname:');
      mkdirSync(join(dir, 'skills', 'metro'), { recursive: true });
      writeFileSync(join(dir, 'skills', 'metro', 'SKILL.md'), '---\nname: metro\n---\nAnswer in French.\n');
      const own = spawnSync('node', [START], { encoding: 'utf8', env });
      const text = (JSON.parse(own.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
      expect(text).toContain('Answer in French.');
      expect(text).not.toContain('name: metro');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

