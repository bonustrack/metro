import { describe, expect, test } from 'bun:test';
import { mcpCallsOf, TOOL_CALL_EXAMPLE } from '../src/mcp-server-protocol.ts';
import { connectorLabel, mcpServerTools, toolSearchDescription, type ConnectorLabel } from '../src/mcp-server-tools.ts';

const named = (...keys: string[]): ConnectorLabel[] => keys.map((key) => ({ key, name: key }));
const TOOL_CALL_DESCRIPTION = mcpServerTools(null, 'session')[1]?.description ?? '';
const MANY = Array.from({ length: 40 }, (_, i) => ({ key: `connector-number-${String(i)}`, name: `A long connector name for number ${String(i)}` }));

describe('the two connector tools every agent sees', () => {
  test('are tool_search and tool_call, read-only and destructive, in that order', () => {
    const [search, call] = mcpServerTools(named('notion'));
    expect([search?.name, call?.name]).toEqual(['tool_search', 'tool_call']);
    expect(search?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(call?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });

  test('stay well under the 2,048 characters Claude Code keeps of a description, even with many connectors', () => {
    for (const keys of [null, [], named('notion', 'n8n-anderra'), MANY]) expect(toolSearchDescription(keys).length).toBeLessThan(2048);
    expect(toolSearchDescription(named('notion')).length).toBeLessThan(1800);
    expect(TOOL_CALL_DESCRIPTION.length).toBeLessThan(1800);
  });

  test('name each connector after its key, unless the name is only the key in other letters', () => {
    expect(connectorLabel({ key: 'x50-rosa-bonustrack-co', name: 'X50 rosa@bonustrack.co' })).toBe('x50-rosa-bonustrack-co (X50 rosa@bonustrack.co)');
    expect(connectorLabel({ key: 'notion', name: 'Notion' })).toBe('notion');
    expect(connectorLabel({ key: 'n8n', name: ' n8n\n prod ' })).toBe('n8n (n8n prod)');
    expect(toolSearchDescription([{ key: 'notion', name: 'Notion' }, { key: 'n8n-anderra', name: 'n8n Anderra' }])).toContain("This agent's connectors: notion, n8n-anderra (n8n Anderra).");
    expect(toolSearchDescription(MANY)).toContain('connectors: connector-number-0, connector-number-1,');
  });

  test('say how to search and how to call, with an example of each form and of every answer line', () => {
    const search = toolSearchDescription(named('notion', 'linear'));
    expect(search).toContain("Claude Code's ToolSearch");
    expect(search).toContain("This agent's connectors: notion, linear.");
    for (const example of ['"select:notion.search"', '"notion create page"', '"+linear issue"', '<connector>.<tool>', 'tool_call']) expect(search).toContain(example);
    expect(toolSearchDescription([])).toContain('no connectors it may use yet');
    expect(TOOL_CALL_DESCRIPTION).toContain('Always find a tool with tool_search first');
    expect(TOOL_CALL_DESCRIPTION).toContain(`Shape: ${TOOL_CALL_EXAMPLE}`);
    for (const line of ['not_found', 'needs_approval', 'denied or blocked', 'signin', 'unavailable']) expect(TOOL_CALL_DESCRIPTION).toContain(`- ${line}:`);
    expect(TOOL_CALL_DESCRIPTION).toContain('"approval": "<id>"');
  });

  test('the approval line follows where the owner answers: the box session, the page of an agent without a server, or a key of a box', () => {
    const page = mcpServerTools(named('notion'), 'page')[1]?.description ?? '';
    expect(page).toContain('- needs_approval: the owner must approve it on this agent\'s page on metro.box.');
    expect(page).not.toContain('channel message');
    const owner = mcpServerTools(named('notion'), 'owner')[1]?.description ?? '';
    expect(owner).toContain('- needs_approval: the agent\'s owner was asked in chat and on its page on metro.box.');
    expect(owner).not.toContain('channel message');
    for (const text of [page, owner]) expect(text.length).toBeLessThan(1800);
    expect(mcpServerTools(named('notion'))[1]?.description).toBe(TOOL_CALL_DESCRIPTION);
  });

  test('a malformed tool_call answers with the expected shape', () => {
    for (const bad of [{}, { calls: [] }, { calls: [{ tool: 'nope' }] }, { calls: [{ tool: 'notion.search', arguments: 'x' }] }, { tool: 'notion.search' }])
      expect(() => mcpCallsOf(bad)).toThrow(`Expected: ${TOOL_CALL_EXAMPLE}`);
  });
});
