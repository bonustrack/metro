import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConnectorPolicies, localSetConnectorPolicy, readLocalConnectors } from '../src/connectors/store.ts';
import { blockedReason, registerConnectors } from '../src/connectors/gates.ts';
import { storedPolicy } from '../src/policy/policy.ts';
import { policySnapshotPath, watchPolicySnapshot } from '../src/mcp/policy-snapshot.ts';
import { promptBody } from '../src/mcp/permission-prompt.ts';

const GUARD = join(import.meta.dir, '..', '..', '..', 'plugin', 'bin', 'guard.mjs');
const LINEAR = 'lin00000001';
const TWIN = 'twin0000001';

let dir = '';
let vendor: Server;
let vendorBase = '';
let stop: (() => void) | undefined;

function speak(req: IncomingMessage, res: ServerResponse): void {
  let body = '';
  req.on('data', (c: Buffer) => {
    body += c.toString('utf8');
  });
  req.on('end', () => {
    const { method, id } = JSON.parse(body) as { method: string; id?: number };
    const reply = (result: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    };
    if (method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'linear' } });
    else if (method === 'tools/list')
      reply({ tools: [{ name: 'list_issues', title: 'List issues', annotations: { readOnlyHint: true } }, { name: 'delete_issue', annotations: { destructiveHint: true } }] });
    else res.writeHead(202).end();
  });
}

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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-connector-policy-'));
  process.env.METRO_AGENTS_DIR = dir;
  vendor = createServer(speak);
  await new Promise<void>((done) => vendor.listen(0, '127.0.0.1', done));
  vendorBase = `http://127.0.0.1:${String((vendor.address() as AddressInfo).port)}`;
  const config = { auth: { kind: 'none' }, createdAt: '', verified: { at: '', server: '' } };
  writeFileSync(
    join(dir, 'connectors.json'),
    JSON.stringify({
      version: 1,
      connectors: [
        { id: LINEAR, name: 'Linear', url: `${vendorBase}/mcp`, config: { ...config, policy: { read: 'sometimes', write: 'ask' }, toolGroups: ['old', 'catalog'] } },
        { id: TWIN, name: 'linear', url: `${vendorBase}/mcp`, config },
      ],
    }),
  );
  stop = watchPolicySnapshot();
  await loadConnectorPolicies(dir);
});

afterAll(() => {
  stop?.();
  registerConnectors([]);
  vendor.close();
  delete process.env.METRO_AGENTS_DIR;
});

describe('a connector carries a tool policy', () => {
  test('the stored policy is read tolerantly, a bad value dropped, and the tool groups come from the vendor at boot', () => {
    const [row] = readLocalConnectors(dir);
    expect(row?.config.policy).toEqual({ write: 'ask' });
    expect(row?.config.toolGroups).toEqual({ list_issues: 'read', delete_issue: 'write' });
    expect(storedPolicy({ kind: 'connector', id: LINEAR })).toEqual({ write: 'ask' });
    expect(storedPolicy({ kind: 'connector', id: TWIN })).toBeUndefined();
  });

  test('saving a policy stores it on the row and in the snapshot, keyed by the plugin server key', async () => {
    const saved = await localSetConnectorPolicy(LINEAR, { write: 'deny', tools: { list_issues: 'ask' } }, dir);
    expect(saved.policy).toEqual({ write: 'deny', tools: { list_issues: 'ask' } });
    const connectors = snapshot().connectors as Record<string, { id: string; name: string; policy: unknown; tools: unknown }>;
    expect(Object.keys(connectors)).toEqual(['linear', 'linear-twin']);
    expect(connectors.linear).toEqual({
      id: LINEAR,
      name: 'Linear',
      policy: { write: 'deny', tools: { list_issues: 'ask' } },
      tools: { list_issues: 'read', delete_issue: 'write' },
    });
    expect(connectors['linear-twin']).toMatchObject({ id: TWIN, policy: {} });
  });

  test('the daemon blocks what the policy denies, by tool group, and only that', () => {
    expect(blockedReason(LINEAR, 'delete_issue')).toBe("Blocked by the owner's policy for Linear (delete_issue).");
    expect(blockedReason(LINEAR, 'unknown_tool')).toBe("Blocked by the owner's policy for Linear (unknown_tool).");
    expect(blockedReason(LINEAR, 'list_issues')).toBeNull();
    expect(blockedReason(TWIN, 'delete_issue')).toBeNull();
  });

  test('the hook maps Claude Code tool names to the connector and applies its policy', () => {
    expect(hook('mcp__plugin_metro_linear__delete_issue', true)).toBe("deny: Blocked by the owner's policy for Linear (delete_issue).");
    expect(hook('mcp__plugin_metro_linear__list_issues', true)).toBe('ask: The owner asked to approve list_issues on Linear.');
    expect(hook('mcp__linear__delete_issue', true)).toMatch(/^deny: Blocked/);
    expect(hook('mcp__metro_box_Linear__delete_issue', true)).toMatch(/^deny: Blocked/);
    expect(hook('mcp__plugin_metro_linear-twin__delete_issue', true)).toBe('allow');
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
