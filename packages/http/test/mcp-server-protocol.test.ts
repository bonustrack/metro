import { describe, expect, test } from 'bun:test';
import { MCP_CALLS_MAX, MCP_FIND_MAX, MCP_TOKEN_RE, mcpAnswerOf, mcpApprovalsOf, mcpCallsOf, mcpFindRequestOf, mcpTokenHashOf, splitMcpTool } from '../src/mcp-server-protocol.ts';

describe('the mcp.metro.box protocol', () => {
  test('tool names are <connector key>.<tool>', () => {
    expect(splitMcpTool('notion.search')).toEqual({ connector: 'notion', tool: 'search' });
    expect(splitMcpTool('n8n-anderra.get_workflow_details')).toEqual({ connector: 'n8n-anderra', tool: 'get_workflow_details' });
    for (const bad of ['notion', '.search', 'Notion.search', 'notion.', 'a b.c', `${'a'.repeat(64)}.x`]) expect(splitMcpTool(bad)).toBeNull();
  });

  test('find requests default to 5 results and cap at 20', () => {
    expect(mcpFindRequestOf({ query: ' notion page ' })).toEqual({ query: 'notion page', max_results: 5 });
    expect(mcpFindRequestOf({ query: 'select:notion.search', max_results: 99 }).max_results).toBe(MCP_FIND_MAX);
    for (const bad of [{}, { query: '' }, { query: 'x'.repeat(501) }, { query: 'a', max_results: 0 }, { query: 'a', max_results: 1.5 }]) expect(() => mcpFindRequestOf(bad)).toThrow();
  });

  test('calls take 1 to 10 named tools with object arguments and an optional 5-letter approval id', () => {
    expect(mcpCallsOf({ calls: [{ tool: 'notion.search', arguments: { query: 'x' } }] })).toEqual([{ tool: 'notion.search', arguments: { query: 'x' } }]);
    expect(mcpCallsOf({ calls: [{ tool: 'linear.create', approval: 'abcde' }] })).toEqual([{ tool: 'linear.create', arguments: {}, approval: 'abcde' }]);
    expect(() => mcpCallsOf({ calls: [{ tool: 'linear.create', approval: 'ABCDE' }] })).toThrow('5-letter');
    expect(() => mcpCallsOf({ calls: [{ tool: 'linear.create', approval: 'abcdl' }] })).toThrow('5-letter');
    expect(() => mcpCallsOf({ calls: [] })).toThrow();
    expect(() => mcpCallsOf({ calls: Array.from({ length: MCP_CALLS_MAX + 1 }, () => ({ tool: 'a.b' })) })).toThrow();
    expect(() => mcpCallsOf({ calls: [{ tool: 'search' }] })).toThrow('<connector>.<tool>');
    expect(() => mcpCallsOf({ calls: [{ tool: 'a.b', arguments: [] }] })).toThrow('must be an object');
  });

  test('daemon requests and answers are read strictly', () => {
    expect(MCP_TOKEN_RE.test(`mcp_${'A'.repeat(43)}`)).toBe(true);
    expect(mcpTokenHashOf({ tokenHash: 'a'.repeat(43) })).toBe('a'.repeat(43));
    expect(() => mcpTokenHashOf({ tokenHash: 'short' })).toThrow();
    expect(mcpApprovalsOf({ approvals: [{ id: 'abcde', connector: 'notion', tool: 'update_page', preview: '{}', requestedAt: 1 }, { id: 'bad' }] })).toHaveLength(1);
    expect(mcpAnswerOf({ id: 'abcde', decision: 'allow' })).toEqual({ id: 'abcde', decision: 'allow' });
    expect(() => mcpAnswerOf({ id: 'abcde', decision: 'maybe' })).toThrow();
  });

  test('an approval says who made the call when the server knows it, and an unknown origin is read as none', () => {
    const base = { id: 'abcde', connector: 'notion', tool: 'update_page', preview: '{}', requestedAt: 1 };
    const read = (extra: Record<string, unknown>) => mcpApprovalsOf({ approvals: [{ ...base, ...extra }] })[0];
    expect(read({})).toEqual(base);
    expect(read({ origin: 'box', keyLabel: 'ignored' })).toEqual({ ...base, origin: 'box' });
    expect(read({ origin: 'key', keyLabel: ' Laptop ' })).toEqual({ ...base, origin: 'key', keyLabel: 'Laptop' });
    expect(read({ origin: 'key', keyLabel: 'Lap\ntop\u0007' })).toEqual({ ...base, origin: 'key', keyLabel: 'Laptop' });
    expect(read({ origin: 'key' })).toEqual({ ...base, origin: 'key' });
    expect(read({ origin: 'key', keyLabel: 'x'.repeat(65) })).toEqual({ ...base, origin: 'key' });
    expect(read({ origin: 'key', keyLabel: 7 })).toEqual({ ...base, origin: 'key' });
    expect(read({ origin: 'remote', keyLabel: 'Laptop' })).toEqual(base);
    expect(read({ origin: 3 })).toEqual(base);
  });
});
