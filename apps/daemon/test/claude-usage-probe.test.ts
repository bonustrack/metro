import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeUsage, usageProbeCommand } from '../src/claude/usage-probe.ts';
import { recordedClaudeUsageAnswer } from './usage-fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'metro-claude-usage-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const answering = (name: string, lines: string[]): string[] => {
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, lines.map((line) => `${line}\n`).join(''));
  return ['sh', '-c', 'cat > "$0.in"; cat "$0"', file];
};

describe('asking Claude Code for the usage of its own login', () => {
  test('one get_usage request goes in, and the rate limits of the answer come out', async () => {
    const command = answering('ok', ['{"type":"system","subtype":"hook_started"}', 'not json', recordedClaudeUsageAnswer]);
    const limits = (await readClaudeUsage({ command })) as { five_hour: { utilization: number } };
    expect(limits.five_hour.utilization).toBe(11);
    const sent = readFileSync(`${command[3] ?? ''}.in`, 'utf8');
    expect(sent.endsWith('\n')).toBe(true);
    expect(JSON.parse(sent)).toEqual({ type: 'control_request', request_id: 'metro-usage', request: { subtype: 'get_usage', skip_behaviors: true } });
  });

  test('a login with no plan limits answers null, a refusal or silence is an error', async () => {
    const none = answering('none', ['{"type":"control_response","response":{"subtype":"success","request_id":"metro-usage","response":{"rate_limits_available":false,"rate_limits":null}}}']);
    expect(await readClaudeUsage({ command: none })).toBeNull();
    const refused = answering('refused', ['{"type":"control_response","response":{"subtype":"error","request_id":"metro-usage","error":"Unsupported control request"}}']);
    await expect(readClaudeUsage({ command: refused })).rejects.toThrow('Unsupported control request');
    const other = answering('other', ['{"type":"control_response","response":{"subtype":"success","request_id":"someone-else","response":{"rate_limits":{}}}}']);
    await expect(readClaudeUsage({ command: other })).rejects.toThrow('no usage answer');
    await expect(readClaudeUsage({ command: ['sh', '-c', 'sleep 5'], timeoutMs: 100 })).rejects.toThrow('in time');
    await expect(readClaudeUsage({ command: [join(dir, 'no-such-claude')] })).rejects.toThrow();
  });

  test('the probe reads no user settings, starts no MCP server and keeps no session', () => {
    const command = usageProbeCommand();
    expect(command).toContain('--setting-sources');
    expect(command[command.indexOf('--setting-sources') + 1]).toBe('project');
    expect(command).toContain('--strict-mcp-config');
    expect(command).toContain('--no-session-persistence');
  });
});
