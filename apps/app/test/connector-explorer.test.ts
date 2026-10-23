import { describe, expect, test } from 'bun:test';
import type { ConnectorTool } from '@metro-labs/client/api/connectors';
import type { ToolPolicy } from '@metro-labs/client/api/policy';
import { toolInputs } from '../src/lib/connector-inputs.ts';
import { addressProblem, nameFromAddress } from '../src/lib/connector-address.ts';
import {
  explorerTools, filterCounts, filterTools, groupChoice, groupFloor, isChanged, stricterAgents, toolChoice, toolFloor, visibleFilters, withGroupChoice, withToolChoice, type ExplorerTool,
} from '../src/lib/connector-rules.ts';
import { agentRuleSummary, effectiveRule, summaryText } from '../src/lib/connector-summary.ts';
import { toolRulesText } from '../src/lib/rule-sentence.ts';
import { looserThan } from '../src/lib/permission-words.ts';

const tool = (name: string, readOnly: boolean, extra: Partial<ConnectorTool> = {}): ConnectorTool => ({
  name, title: name, description: '', readOnly, destructive: false, openWorld: false, inputSchema: null, ...extra,
});

const LISTED = [tool('search', true, { description: 'Find pages' }), tool('fetch', true), tool('create', false), tool('update', false), tool('delete', false, { destructive: true })];
const named = (tools: ExplorerTool[], name: string): ExplorerTool => {
  const found = tools.find((row) => row.name === name);
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
};

describe('the inputs of a tool', () => {
  test('nested objects and arrays read as one flat table', () => {
    const schema = {
      type: 'object',
      required: ['pages'],
      properties: {
        parent: { type: 'object', description: 'Where they go.' },
        pages: {
          type: 'array',
          description: 'The pages to create.',
          items: { type: 'object', required: ['properties'], properties: { properties: { type: 'object' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } },
        },
        mode: { enum: ['fast', 'full'] },
        limit: { type: ['integer', 'null'] },
        target: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
    };
    expect(toolInputs(schema)).toEqual([
      { name: 'parent', type: 'object', required: false, description: 'Where they go.' },
      { name: 'pages', type: 'array', required: true, description: 'The pages to create.' },
      { name: 'pages[].properties', type: 'object', required: true, description: '' },
      { name: 'pages[].content', type: 'string', required: false, description: '' },
      { name: 'pages[].tags', type: 'array', required: false, description: '' },
      { name: 'mode', type: 'choice', required: false, description: 'One of: fast, full.' },
      { name: 'limit', type: 'integer', required: false, description: '' },
      { name: 'target', type: 'string or number', required: false, description: '' },
    ]);
  });

  test('no schema gives no table, an empty one gives no rows, and nested objects carry their path', () => {
    expect(toolInputs(null)).toEqual([]);
    expect(toolInputs({ type: 'object', properties: {} })).toEqual([]);
    expect(toolInputs({ type: 'object', properties: { filter: { type: 'object', required: ['field'], properties: { field: { type: 'string' } } } } }).map((row) => [row.name, row.required])).toEqual([['filter', false], ['filter.field', true]]);
  });
});

describe('the organization rules of a connector', () => {
  const tools = explorerTools(LISTED, [{ tools: { gone: 'deny' } }]);

  test('read-only tools are Read, the rest Write, and a saved rule for a tool the service dropped stays listed as Write', () => {
    expect(tools.map((row) => [row.name, row.group, row.listed])).toEqual([
      ['search', 'read', true], ['fetch', 'read', true], ['create', 'write', true], ['update', 'write', true], ['delete', 'write', true], ['gone', 'write', false],
    ]);
  });

  test('a group is Mixed when its tools differ, and setting it sets every tool of the group', () => {
    const scope = { policy: { write: 'ask', tools: { delete: 'deny' } } satisfies ToolPolicy };
    expect(groupChoice(scope, tools, 'read')).toBe('allow');
    expect(groupChoice({ policy: { write: 'ask' } }, tools, 'write')).toBe('ask');
    expect(groupChoice(scope, tools, 'write')).toBe('mixed');
    const next = withGroupChoice(scope, tools, 'write', 'block');
    expect(next).toEqual({ write: 'deny' });
    expect(groupChoice({ policy: next }, tools, 'write')).toBe('block');
    expect(withGroupChoice({ policy: { read: 'ask' } }, tools, 'read', 'allow')).toEqual({});
  });

  test('a tool rule is kept only where it differs from its group', () => {
    const scope = { policy: { write: 'ask' } satisfies ToolPolicy };
    expect(withToolChoice(scope, named(tools, 'delete'), 'block')).toEqual({ write: 'ask', tools: { delete: 'deny' } });
    expect(withToolChoice({ policy: { write: 'ask', tools: { delete: 'deny' } } }, named(tools, 'delete'), 'ask')).toEqual({ write: 'ask' });
  });

  test('Changed counts the tools that are not Allow, and search looks at titles, names and descriptions', () => {
    const scope = { policy: { write: 'ask', tools: { gone: 'deny' } } satisfies ToolPolicy };
    expect(filterCounts(tools, scope)).toEqual({ all: 6, read: 2, write: 4, changed: 4 });
    expect(filterTools(tools, scope, 'changed', '').map((row) => row.name)).toEqual(['create', 'update', 'delete', 'gone']);
    expect(filterTools(tools, scope, 'all', 'pages').map((row) => row.name)).toEqual(['search']);
    expect(filterTools(tools, scope, 'read', 'up').map((row) => row.name)).toEqual([]);
  });
});

describe('an agent can only be stricter than the organization', () => {
  const tools = explorerTools(LISTED, []);
  const organization: ToolPolicy = { write: 'ask', tools: { fetch: 'deny' } };

  test('the organization rule is the floor, and a looser choice is not offered', () => {
    const scope = { policy: {}, organization };
    const fetch = named(tools, 'fetch');
    expect(toolChoice(scope, fetch)).toBe('block');
    expect(toolFloor(scope, fetch)).toBe('block');
    expect(looserThan('allow', toolFloor(scope, named(tools, 'create')))).toBe(true);
    expect(toolChoice({ policy: { read: 'deny', tools: { search: 'allow' } }, organization }, named(tools, 'search'))).toBe('allow');
    expect(groupFloor(scope, tools, 'read')).toBe('allow');
    expect(groupFloor(scope, tools, 'write')).toBe('ask');
    expect(groupFloor({ policy: {} }, tools, 'write')).toBeNull();
  });

  test('a stricter tool is saved, the same rule as the organization is dropped', () => {
    const create = named(tools, 'create');
    const blocked = withToolChoice({ policy: {}, organization }, create, 'block');
    expect(blocked).toEqual({ tools: { create: 'deny' } });
    expect(withToolChoice({ policy: blocked, organization }, create, 'ask')).toEqual({});
    expect(isChanged({ policy: blocked, organization }, create)).toBe(true);
    expect(isChanged({ policy: {}, organization }, create)).toBe(false);
  });

  test('setting a group to what the organization already asks follows the organization', () => {
    expect(withGroupChoice({ policy: { tools: { create: 'deny' } }, organization }, tools, 'write', 'ask')).toEqual({});
    expect(withGroupChoice({ policy: {}, organization }, tools, 'read', 'allow')).toEqual({});
    expect(withGroupChoice({ policy: {}, organization }, tools, 'read', 'ask')).toEqual({ read: 'ask' });
  });

  test('the organization view names the agents with a stricter rule for one tool', () => {
    const agents = [{ id: 'emma', policy: { tools: { create: 'deny' } } satisfies ToolPolicy }, { id: 'tony', policy: {} }];
    expect(stricterAgents(organization, agents, named(tools, 'create'))).toEqual([{ id: 'emma', choice: 'block' }]);
    expect(stricterAgents(organization, agents, named(tools, 'search'))).toEqual([]);
  });
});

describe('one line per agent and per connector', () => {
  const tools = explorerTools(LISTED, []);
  const organization: ToolPolicy = { write: 'ask' };

  test('the same rule, a group rule, or a count of stricter tools', () => {
    expect(summaryText(agentRuleSummary(organization, {}, tools))).toBe('Same as the organization');
    expect(summaryText(agentRuleSummary(organization, { write: 'allow' }, tools))).toBe('Same as the organization');
    expect(summaryText(agentRuleSummary(organization, { write: 'deny' }, tools))).toBe('Write: Block');
    expect(summaryText(agentRuleSummary(organization, { read: 'ask', write: 'deny' }, tools))).toBe('Read: Ask · Write: Block');
    expect(summaryText(agentRuleSummary(organization, { tools: { create: 'deny', delete: 'deny', search: 'ask' } }, tools))).toBe('Stricter on 3 tools');
    expect(summaryText(agentRuleSummary(organization, { tools: { delete: 'deny' } }, tools))).toBe('Stricter on 1 tool');
  });

  test('without the tool list the line reads the saved rule only', () => {
    expect(summaryText(agentRuleSummary(organization, {}, null))).toBe('Same as the organization');
    expect(summaryText(agentRuleSummary(organization, { write: 'deny' }, null))).toBe('Write: Block');
    expect(summaryText(agentRuleSummary(organization, { tools: { a: 'deny', b: 'ask' } }, null))).toBe('Stricter on 2 tools');
  });

  test('what an agent may do joins both layers, strictest first', () => {
    expect(effectiveRule({ write: 'ask', tools: { a: 'deny' } }, { read: 'ask', write: 'deny', tools: { a: 'deny', b: 'ask' } })).toEqual({
      parts: [{ label: 'Read', choice: 'ask' }, { label: 'Write', choice: 'block' }],
      tools: 2,
    });
    expect(toolRulesText(1)).toBe('1 tool has its own rule');
    expect(toolRulesText(3)).toBe('3 tools have their own rule');
  });
});

describe('the address of a new connector', () => {
  test('the name comes from the server name, without mcp, api or the ending', () => {
    expect(nameFromAddress('https://mcp.notion.com/mcp')).toBe('Notion');
    expect(nameFromAddress('https://mcp.linear.app/sse')).toBe('Linear');
    expect(nameFromAddress('https://api.twenty.com/mcp')).toBe('Twenty');
    expect(nameFromAddress('not an address')).toBe('');
  });

  test('only a full web address goes on', () => {
    expect(addressProblem('')).toBe('Paste the address first.');
    expect(addressProblem('mcp.notion.com')).toBe('Use a full address that starts with https://.');
    expect(addressProblem('ftp://files.example.com')).toBe('Use a web address that starts with https://.');
    expect(addressProblem(' https://mcp.notion.com/mcp ')).toBeNull();
  });
});

describe('the tool filters', () => {
  test('a filter with no tools is hidden, except All and the one in use', () => {
    const counts = { all: 120, read: 0, write: 120, changed: 0 };
    expect(visibleFilters(counts, 'all')).toEqual(['all', 'write']);
    expect(visibleFilters(counts, 'changed')).toEqual(['all', 'write', 'changed']);
    expect(visibleFilters({ all: 0, read: 0, write: 0, changed: 0 }, 'all')).toEqual(['all']);
  });
});
