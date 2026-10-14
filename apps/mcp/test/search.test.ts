import { describe, expect, test } from 'bun:test';
import { functionsText, nameTokens, requiredTerms, searchTools, selectedNames, type SearchTool } from '../src/search.ts';

const tool = (name: string, description = '', title = name): SearchTool => ({ name, title, description, parameters: { type: 'object', properties: {} } });

const TOOLS = [
  tool('notion.search', 'Search pages and databases in the workspace.', 'Search'),
  tool('notion.update_page', 'Update the properties of a page.'),
  tool('notion.create_page', 'Create a page in a database.'),
  tool('linear.create_issue', 'Create an issue in a team.'),
  tool('slack.send_message', 'Send a message to a channel.'),
  tool('slack.list_channels', 'List the channels of the workspace.'),
  tool('n8n-anderra.getWorkflowDetails', 'Read a workflow and its nodes.'),
];

const names = (found: SearchTool[]): string[] => found.map((t) => t.name);

describe('find_tools search', () => {
  test('select: returns exactly the named tools, in the order asked, ignoring unknown names', () => {
    expect(names(searchTools(TOOLS, 'select:linear.create_issue,notion.search', 5))).toEqual(['linear.create_issue', 'notion.search']);
    expect(names(searchTools(TOOLS, 'select: notion.search , missing.tool, notion.search', 5))).toEqual(['notion.search']);
    expect(names(searchTools(TOOLS, 'select:NOTION.SEARCH', 5))).toEqual(['notion.search']);
    expect(searchTools(TOOLS, 'select:', 5)).toEqual([]);
    expect(selectedNames('notion page')).toBeNull();
  });

  test('select: is not cut to max_results', () => {
    expect(names(searchTools(TOOLS, 'select:notion.search,notion.update_page,notion.create_page', 1))).toHaveLength(3);
  });

  test('keywords rank a whole name token above a partial one, and the name above the description', () => {
    expect(names(searchTools(TOOLS, 'notion page update', 5))[0]).toBe('notion.update_page');
    expect(names(searchTools(TOOLS, 'issue', 5))).toEqual(['linear.create_issue']);
    expect(names(searchTools(TOOLS, 'workspace', 5))).toEqual(['notion.search', 'slack.list_channels']);
    expect(names(searchTools(TOOLS, 'workflow', 5))).toEqual(['n8n-anderra.getWorkflowDetails']);
  });

  test('a word only in the description still matches, below name matches', () => {
    const found = names(searchTools(TOOLS, 'database', 5));
    expect(found).toEqual(['notion.create_page', 'notion.search']);
  });

  test('max_results caps keyword results and no match is empty', () => {
    expect(searchTools(TOOLS, 'notion', 2)).toHaveLength(2);
    expect(searchTools(TOOLS, 'zzz', 5)).toEqual([]);
  });

  test('+term requires the word in the tool name and ranks the rest by the other words', () => {
    expect(names(searchTools(TOOLS, '+slack send', 5))).toEqual(['slack.send_message']);
    expect(names(searchTools(TOOLS, '+slack', 5))).toEqual(['slack.list_channels', 'slack.send_message']);
    expect(names(searchTools(TOOLS, '+notion workspace', 5))).toEqual(['notion.search']);
    expect(searchTools(TOOLS, '+jira issue', 5)).toEqual([]);
    expect(requiredTerms('+Slack send +')).toEqual(['slack']);
  });

  test('name tokens split dots, dashes, underscores and camelCase', () => {
    expect(nameTokens('n8n-anderra.getWorkflowDetails')).toEqual(['n8n', 'anderra', 'get', 'workflow', 'details']);
    expect(nameTokens('notion.update_page')).toEqual(['notion', 'update', 'page']);
  });

  test('the output is the ToolSearch <functions> encoding, one function per line', () => {
    const text = functionsText([TOOLS[0] ?? tool('x')]);
    expect(text).toBe('<functions>\n<function>{"name":"notion.search","description":"Search pages and databases in the workspace.","parameters":{"type":"object","properties":{}}}</function>\n</functions>');
  });
});
