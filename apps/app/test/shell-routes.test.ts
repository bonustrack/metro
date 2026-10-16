import { describe, expect, test } from 'bun:test';
import { routeHash, routeSelection } from '@metro-labs/client/route';
import type { Selection } from '@metro-labs/client/selection';
import { configurePlatform, memoryKeyValue } from '@metro-labs/client/platform';
import { AGENT_TABS, agentPageOf, agentTabOf, isPageRoot, type AgentTabId } from '../src/lib/agent-tabs.ts';
import { isTabRoot, phoneBackOf, phoneTabOf, shellSectionOf } from '../src/lib/shell-sections.ts';
import { setTechnicalDetails, technicalDetails } from '../src/lib/technical.ts';

const AGENT = 'aB3-_xYz9Qw';

const AGENT_PAGES: [string, AgentTabId, string | null][] = [
  ['', 'home', null],
  ['/chats', 'chats', 'Channels'],
  ['/channel/a1', 'chats', 'Channels'],
  ['/voice', 'chats', 'Voice'],
  ['/sessions', 'chats', 'Conversations'],
  ['/memory', 'memory', 'Notes'],
  ['/files', 'memory', 'Files'],
  ['/skills', 'memory', 'Skills'],
  ['/skill/user%3Ax', 'memory', 'Skills'],
  ['/tools', 'tools', 'Connectors'],
  ['/scheduled', 'tools', 'Scheduled tasks'],
  ['/scheduled/cron-agent%3A1', 'tools', 'Scheduled tasks'],
  ['/secrets', 'tools', 'Secrets'],
  ['/settings', 'settings', 'General'],
  ['/model', 'settings', 'Model'],
  ['/harness', 'settings', 'Harness'],
  ['/server', 'settings', 'Server'],
  ['/terminal', 'settings', 'Terminal'],
  ['/run', 'home', null],
];

describe('every page of an agent has a place under one of its five tabs', () => {
  test('each address opens the tab and the page it belongs to', () => {
    for (const [suffix, tab, page] of AGENT_PAGES) {
      const selection = routeSelection(`#/${AGENT}${suffix}`);
      expect(agentTabOf(selection.kind).id).toBe(tab);
      expect(agentPageOf(selection.kind)?.label ?? null).toBe(page);
    }
  });

  test('the old Channels and Connectors addresses land on the Chats and Tools tabs', () => {
    for (const [old, tab, page] of [['/channels', 'chats', 'Channels'], ['/connectors', 'tools', 'Connectors'], [`/connector/${AGENT}`, 'tools', 'Connectors']] as const) {
      const selection = routeSelection(`#/${AGENT}${old}`);
      expect(agentTabOf(selection.kind).id).toBe(tab);
      expect(agentPageOf(selection.kind)?.label).toBe(page);
      expect(routeHash(selection)).toEndWith(`/${AGENT}/${tab}`);
    }
  });

  test('a tab opens its first page, and only that first page hides its own title', () => {
    for (const tab of AGENT_TABS) {
      const target = tab.target(AGENT);
      expect(agentTabOf(target.kind).id).toBe(tab.id);
      if (tab.pages.length > 0) expect(tab.pages[0]?.target(AGENT)).toEqual(target);
    }
    expect(isPageRoot({ kind: 'chats', project: AGENT })).toBe(true);
    expect(isPageRoot({ kind: 'station', project: AGENT, accountId: 'a1' })).toBe(false);
    expect(isPageRoot({ kind: 'skill', project: AGENT, id: 'user:x' })).toBe(false);
    expect(isPageRoot({ kind: 'home', project: AGENT })).toBe(false);
    expect(isPageRoot({ kind: 'servers' })).toBe(false);
  });

  test('the five tabs come in the order of the design', () => {
    expect(AGENT_TABS.map((tab) => tab.label)).toEqual(['Home', 'Chats', 'Memory', 'Tools', 'Settings']);
  });
});

describe('the shell knows its section and what a phone shows', () => {
  test('agent pages belong to Agents, organization pages to their own section', () => {
    expect(shellSectionOf({ kind: 'servers' })).toBe('agents');
    expect(shellSectionOf({ kind: 'model', project: AGENT })).toBe('agents');
    expect(shellSectionOf({ kind: 'org-connector', id: AGENT })).toBe('connectors');
    expect(shellSectionOf({ kind: 'org-models' })).toBe('models');
    expect(shellSectionOf({ kind: 'members' })).toBe('organization');
    expect(shellSectionOf({ kind: 'settings' })).toBeNull();
    expect(phoneTabOf({ kind: 'settings' })).toBe('organization');
  });

  test('tab roots have no back, and a pushed page goes back to its list', () => {
    const roots: Selection[] = [{ kind: 'servers' }, { kind: 'org-connectors' }, { kind: 'org-models' }, { kind: 'organization' }];
    for (const root of roots) {
      expect(isTabRoot(root)).toBe(true);
      expect(phoneBackOf(root)).toBeNull();
    }
    expect(phoneBackOf({ kind: 'home', project: AGENT })).toEqual({ kind: 'servers' });
    expect(phoneBackOf({ kind: 'org-connector', id: AGENT })).toEqual({ kind: 'org-connectors' });
    expect(phoneBackOf({ kind: 'settings' })).toEqual({ kind: 'organization' });
  });
});

describe('the technical details switch', () => {
  test('is off by default and remembered on this device', () => {
    configurePlatform({ kv: memoryKeyValue() });
    expect(technicalDetails()).toBe(false);
    setTechnicalDetails(true);
    expect(technicalDetails()).toBe(true);
    setTechnicalDetails(false);
    expect(technicalDetails()).toBe(false);
  });
});
