import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PLUGIN = join(import.meta.dir, '..', '..', '..', 'plugin');
const GUARD = join(PLUGIN, 'bin', 'guard.mjs');
const START = join(PLUGIN, 'bin', 'session-start.mjs');

const EMPTY = mkdtempSync(join(tmpdir(), 'metro-guard-empty-'));

function guard(payload: unknown, agentsDir = EMPTY): string {
  const run = spawnSync('node', [GUARD], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, METRO_AGENTS_DIR: agentsDir },
  });
  if (run.stdout.trim() === '') return 'allow';
  const out = JSON.parse(run.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  return `${out.hookSpecificOutput.permissionDecision}: ${out.hookSpecificOutput.permissionDecisionReason.slice(0, 40)}`;
}

describe('the orchestrator guard the plugin ships', () => {
  test('the main thread may delegate, talk over metro, schedule, and look at images; nothing else', () => {
    expect(guard({ tool_name: 'Agent', tool_input: {} })).toBe('allow');
    expect(guard({ tool_name: 'Workflow', tool_input: {} })).toBe('allow');
    expect(guard({ tool_name: 'mcp__metro__send', tool_input: {} })).toBe('allow');
    expect(guard({ tool_name: 'mcp__plugin_metro_zapier__run', tool_input: {} })).toContain('connector');
    expect(guard({ tool_name: 'mcp__plugin_metro_zapier__run', tool_input: {}, agent_id: 'sub' })).toBe('allow');
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

const TG = 'tg000000001';
const TG2 = 'tg000000002';
const LINE = `metro://telegram/${TG}/-100555`;

const SNAPSHOT = {
  version: 1,
  tools: { send: 'write', read: 'read', delete: 'write', get_profile: 'read', create_group: 'write', group_info: 'read', list_accounts: 'read' },
  owners: { group_info: 'xmtp' },
  ungated: ['list_accounts', 'create_upload'],
  accounts: {
    [`telegram/${TG}`]: { write: 'ask', tools: { delete: 'deny' } },
    [`telegram/${TG2}`]: { read: 'deny' },
    'xmtp/xm000000001': { read: 'ask' },
  },
  stations: { telegram: [TG, TG2], xmtp: ['xm000000001'] },
};

describe('the owner policy the guard applies to metro tools', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metro-guard-policy-'));
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(SNAPSHOT));
  const main = (tool: string, input: Record<string, unknown>): string => guard({ tool_name: `mcp__metro__${tool}`, tool_input: input }, dir);
  const worker = (tool: string, input: Record<string, unknown>): string =>
    guard({ tool_name: `mcp__metro__${tool}`, tool_input: input, agent_id: 'w1' }, dir);

  test('an approval is asked inside a worker, and refused on the main thread with the way out', () => {
    expect(worker('send', { line: LINE, text: 'hi' })).toMatch(/^ask: The owner asked to approve send on/);
    expect(main('send', { line: LINE, text: 'hi' })).toMatch(/^deny: send on telegram \(tg000000001\) needs the/);
    const full = spawnSync('node', [GUARD], {
      input: JSON.stringify({ tool_name: 'mcp__metro__send', tool_input: { line: LINE } }),
      encoding: 'utf8',
      env: { ...process.env, METRO_AGENTS_DIR: dir },
    }).stdout;
    expect(full).toContain('run_in_background: true');
  });

  test('a blocked tool is denied everywhere, and a per-tool entry beats the group', () => {
    expect(main('delete', { line: LINE, message_id: 'm1' })).toMatch(/^deny: Blocked by the owner's policy for tele/);
    expect(worker('delete', { line: LINE, message_id: 'm1' })).toMatch(/^deny: Blocked by the owner's policy for tele/);
    expect(main('read', { line: LINE })).toBe('allow');
  });

  test('the target comes from the line, an account override, the account alone, or the whole station', () => {
    expect(main('read', { line: LINE, account: TG2 })).toMatch(/^deny: Blocked/);
    expect(main('read', { account: TG2 })).toMatch(/^deny: Blocked/);
    expect(main('read', { account: TG })).toBe('allow');
    expect(worker('create_group', { station: 'telegram', name: 'crew' })).toMatch(/^ask/);
    expect(worker('group_info', {})).toMatch(/^ask: The owner asked to approve group_info on/);
    expect(main('get_profile', { from: `metro://telegram/${TG2}/user/42` })).toMatch(/^deny: Blocked/);
    expect(main('list_accounts', {})).toBe('allow');
  });

  test('an unknown tool counts as a write, and a call with no channel passes', () => {
    expect(worker('brand_new_tool', { line: LINE })).toMatch(/^ask/);
    expect(main('create_upload', { name: 'a.png' })).toBe('allow');
    expect(main('send', { text: 'no target' })).toBe('allow');
  });

  test('with no snapshot, or one that does not parse, the call passes (the daemon still refuses what is blocked)', () => {
    expect(guard({ tool_name: 'mcp__metro__delete', tool_input: { line: LINE } })).toBe('allow');
    const broken = mkdtempSync(join(tmpdir(), 'metro-guard-broken-'));
    writeFileSync(join(broken, 'policy.json'), '{nope');
    expect(guard({ tool_name: 'mcp__metro__delete', tool_input: { line: LINE } }, broken)).toBe('allow');
  });

  test('other tools keep the guard rules they had', () => {
    expect(guard({ tool_name: 'Bash', tool_input: {} }, dir)).toMatch(/^deny: The main thread is orchestrator-only/);
    expect(guard({ tool_name: 'Bash', agent_id: 'w1', tool_input: {} }, dir)).toBe('allow');
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
