import { describe, expect, test } from 'bun:test';
import { mcpCallsOf, TOOL_CALL_EXAMPLE } from '../src/mcp-server-protocol.ts';
import { mcpServerTools, TOOL_CALL_DESCRIPTION, toolSearchDescription } from '../src/mcp-server-tools.ts';

const MANY = Array.from({ length: 40 }, (_, i) => `connector-number-${String(i)}`);

describe('the two connector tools every agent sees', () => {
  test('are tool_search and tool_call, read-only and destructive, in that order', () => {
    const [search, call] = mcpServerTools(['notion']);
    expect([search?.name, call?.name]).toEqual(['tool_search', 'tool_call']);
    expect(search?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(call?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });

  test('stay well under the 2,048 characters Claude Code keeps of a description, even with many connectors', () => {
    for (const keys of [null, [], ['notion', 'n8n-anderra'], MANY]) expect(toolSearchDescription(keys).length).toBeLessThan(2048);
    expect(toolSearchDescription(['notion']).length).toBeLessThan(1800);
    expect(TOOL_CALL_DESCRIPTION.length).toBeLessThan(1800);
  });

  test('say how to search and how to call, with an example of each form and of every answer line', () => {
    const search = toolSearchDescription(['notion', 'linear']);
    expect(search).toContain("Claude Code's ToolSearch");
    expect(search).toContain("This agent's connectors: notion, linear.");
    for (const example of ['"select:notion.search"', '"notion create page"', '"+linear issue"', '<connector>.<tool>', 'tool_call']) expect(search).toContain(example);
    expect(toolSearchDescription([])).toContain('no connectors it may use yet');
    expect(TOOL_CALL_DESCRIPTION).toContain('Always find a tool with tool_search first');
    expect(TOOL_CALL_DESCRIPTION).toContain(`Shape: ${TOOL_CALL_EXAMPLE}`);
    for (const line of ['not_found', 'needs_approval', 'denied or blocked', 'signin', 'unavailable']) expect(TOOL_CALL_DESCRIPTION).toContain(`- ${line}:`);
    expect(TOOL_CALL_DESCRIPTION).toContain('"approval": "<id>"');
  });

  test('a malformed tool_call answers with the expected shape', () => {
    for (const bad of [{}, { calls: [] }, { calls: [{ tool: 'nope' }] }, { calls: [{ tool: 'notion.search', arguments: 'x' }] }, { tool: 'notion.search' }])
      expect(() => mcpCallsOf(bad)).toThrow(`Expected: ${TOOL_CALL_EXAMPLE}`);
  });
});
