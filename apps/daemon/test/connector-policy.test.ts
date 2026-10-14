import { answerPrompt, holdPrompt, pendingPrompts } from '../src/approvals/pending.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockedReason, registerConnectors } from '../src/connectors/gates.ts';
import { storedPolicy } from '../src/policy/policy.ts';
import { policySnapshotPath, watchPolicySnapshot } from '../src/mcp/policy-snapshot.ts';
import { promptBody } from '../src/mcp/permission-prompt.ts';

const GUARD = join(import.meta.dir, '..', '..', '..', 'plugin', 'bin', 'guard.mjs');
const LINEAR = 'org-lin00000001';
const TWIN = 'org-twin0000001';

let dir = '';
let stop: (() => void) | undefined;
const previous = process.env.METRO_AGENTS_DIR;

function hook(tool: string, subagent: boolean): string {
  const run = spawnSync('node', [GUARD], {
    input: JSON.stringify({ tool_name: tool, tool_input: { id: 'ISS-1' }, ...(subagent ? { agent_id: 'w1' } : {}) }),
    encoding: 'utf8',
    env: { ...process.env, METRO_AGENTS_DIR: dir },
  });
  if (run.stdout.trim() === '') return 'allow';
  const out = JSON.parse(run.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  return `${out.hookSpecificOutput.permissionDecision}: ${out.hookSpecificOutput.permissionDecisionReason}`;
}

const snapshot = (): Record<string, unknown> => JSON.parse(readFileSync(policySnapshotPath(dir), 'utf8')) as Record<string, unknown>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-connector-policy-'));
  process.env.METRO_AGENTS_DIR = dir;
  stop = watchPolicySnapshot();
  registerConnectors([
    { id: LINEAR, name: 'Linear', config: { policy: { write: 'ask' }, toolGroups: { list_issues: 'read', delete_issue: 'write' } } },
    { id: TWIN, name: 'linear', config: {} },
  ]);
});

afterAll(() => {
  stop?.();
  registerConnectors([]);
  if (previous === undefined) delete process.env.METRO_AGENTS_DIR;
  else process.env.METRO_AGENTS_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe('an organization connector carries a tool policy', () => {
  test('the policy is registered by relay id, and the snapshot keys it by the plugin server key', () => {
    expect(storedPolicy({ kind: 'connector', id: LINEAR })).toEqual({ write: 'ask' });
    expect(storedPolicy({ kind: 'connector', id: TWIN })).toBeUndefined();
    const connectors = snapshot().connectors as Record<string, { id: string; name: string; policy: unknown; tools: unknown }>;
    expect(Object.keys(connectors).sort()).toEqual(['linear', 'linear-1']);
    expect(connectors.linear).toEqual({ id: LINEAR, name: 'Linear', policy: { write: 'ask' }, tools: { list_issues: 'read', delete_issue: 'write' } });
    expect(connectors['linear-1']).toMatchObject({ id: TWIN, policy: {} });
  });

  test('the daemon asks for what the policy asks, and runs an ask call only once it was approved', async () => {
    expect(blockedReason(LINEAR, 'delete_issue')).toStartWith("Needs the owner's approval for Linear (delete_issue).");
    expect(blockedReason(LINEAR, 'list_issues')).toBeNull();
    registerConnectors([
      { id: LINEAR, name: 'Linear', config: { policy: { write: 'deny', tools: { list_issues: 'ask' } }, toolGroups: { list_issues: 'read', delete_issue: 'write' } } },
      { id: TWIN, name: 'linear', config: {} },
    ]);
    expect(blockedReason(LINEAR, 'delete_issue')).toBe("Blocked by the owner's policy for Linear (delete_issue).");
    expect(blockedReason(LINEAR, 'unknown_tool')).toBe("Blocked by the owner's policy for Linear (unknown_tool).");
    expect(blockedReason(LINEAR, 'list_issues')).toStartWith("Needs the owner's approval for Linear (list_issues).");
    holdPrompt({ requestId: 'lnrqa', tool: 'mcp__plugin_metro_linear__list_issues', description: '', preview: '{"team":"core"}', line: undefined, at: Date.now() }, {}, () => Promise.resolve());
    await answerPrompt('lnrqa', 'allow', 'page');
    expect(blockedReason(TWIN, 'list_issues', { team: 'core' })).toBeNull();
    expect(blockedReason(LINEAR, 'list_issues', { team: 'other' })).toStartWith("Needs the owner's approval");
    expect(blockedReason(LINEAR, 'list_issues', { team: 'core' })).toBeNull();
    expect(blockedReason(LINEAR, 'list_issues', { team: 'core' })).toStartWith("Needs the owner's approval");
    expect(blockedReason(TWIN, 'delete_issue')).toBeNull();
    expect(blockedReason('org-gone0000001', 'list_issues')).toBe('This connector is not available.');
  });

  test('a call approved only in the terminal is refused and its dead prompt leaves the page', () => {
    holdPrompt({ requestId: 'lnrqb', tool: 'mcp__plugin_metro_linear__list_issues', description: '', preview: '{"team":"ops"}', line: undefined, at: Date.now() }, {}, () => Promise.resolve());
    expect(pendingPrompts().some((p) => p.requestId === 'lnrqb')).toBe(true);
    expect(blockedReason(LINEAR, 'list_issues', { team: 'ops' })).toStartWith("Needs the owner's approval");
    expect(pendingPrompts().some((p) => p.requestId === 'lnrqb')).toBe(false);
  });

  test('the hook maps Claude Code tool names to the connector and applies its policy', () => {
    expect(hook('mcp__plugin_metro_linear__delete_issue', true)).toBe("deny: Blocked by the owner's policy for Linear (delete_issue).");
    expect(hook('mcp__plugin_metro_linear__list_issues', true)).toBe('ask: The owner asked to approve list_issues on Linear.');
    expect(hook('mcp__linear__delete_issue', true)).toMatch(/^deny: Blocked/);
    expect(hook('mcp__metro_box_Linear__delete_issue', true)).toBe('allow');
    expect(hook('mcp__plugin_metro_linear-1__delete_issue', true)).toBe('allow');
    expect(hook('mcp__plugin_metro_linear__list_issues', false)).toMatch(/^deny: A connector call is work/);
    expect(hook('mcp__plugin_other_linear__delete_issue', true)).toBe('allow');
  });

  test('a relayed approval prompt names the connector, the tool and the arguments', () => {
    expect(
      promptBody({
        request_id: 'abcde',
        tool_name: 'mcp__plugin_metro_linear__list_issues',
        description: 'List issues',
        input_preview: JSON.stringify({ team: 'ENG', filter: { state: 'open' }, empty: '' }),
      }),
    ).toBe('Approval needed: list_issues\nConnector: Linear\nteam: ENG\nfilter: {"state":"open"}\n\nReply "yes abcde" or "no abcde"');
  });
});
