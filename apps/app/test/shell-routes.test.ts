import { describe, expect, test } from 'bun:test';
import { routeHash, routeSelection } from '@metro-labs/client/route';
import type { Selection } from '@metro-labs/client/selection';
import { configurePlatform, memoryKeyValue } from '@metro-labs/client/platform';
import { AGENT_TABS, agentPageOf, agentTabOf, isDeepPage, isPageRoot, shallowPages, type AgentTabId } from '../src/lib/agent-tabs.ts';
import { isTabRoot, phoneBackOf, phoneTabOf, shellSectionOf } from '../src/lib/shell-sections.ts';
import { isFocusPage } from '../src/lib/focus-pages.ts';
import { setTechnicalDetails, technicalDetails } from '../src/lib/technical.ts';

const AGENT = 'aB3-_xYz9Qw';

const AGENT_PAGES: [string, AgentTabId, string | null][] = [
  ['', 'home', null],
  ['/chats', 'chats', 'Chats'],
  ['/channel/a1', 'chats', 'Channel'],
  ['/channel/a1/write', 'chats', 'Channel'],
  ['/channel/a1/exceptions/typing', 'chats', 'Channel'],
  ['/voice', 'chats', 'Voice calls'],
  ['/sessions', 'chats', 'Conversations'],
  ['/memory', 'memory', 'Notes'],
  ['/files', 'memory', 'Files'],
  ['/skills', 'memory', 'Skills'],
  ['/skill/user%3Ax', 'memory', 'Skill'],
  ['/tools', 'tools', 'Tools'],
  ['/scheduled', 'tools', 'Tools'],
  ['/scheduled/cron-agent%3A1', 'tools', 'Routine'],
  ['/secrets', 'tools', 'Tools'],
  ['/settings', 'settings', 'Settings'],
  ['/model', 'settings', 'Model'],
  ['/harness', 'settings', 'Agent SDK setup'],
  ['/server', 'settings', 'Server'],
  ['/terminal', 'settings', 'Terminal'],
  ['/run', 'home', 'Right now'],
  ['/run/event/e04bd134128bfb68', 'home', 'Right now'],
  ['/chats/add', 'chats', 'Add a chat'],
  ['/chats/add/telegram-bot', 'chats', 'Add a chat'],
  ['/skills/github', 'memory', 'GitHub skills'],
  ['/secrets/recent', 'tools', 'Recent use'],
  ['/profile', 'settings', 'Profile'],
  ['/backup', 'settings', 'Backup'],
  ['/launch-log', 'settings', 'Launch log'],
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
    for (const [old, tab, page] of [['/channels', 'chats', 'Chats'], ['/connectors', 'tools', 'Tools']] as const) {
      const selection = routeSelection(`#/${AGENT}${old}`);
      expect(agentTabOf(selection.kind).id).toBe(tab);
      expect(agentPageOf(selection.kind)?.label).toBe(page);
      expect(routeHash(selection)).toEndWith(`/${AGENT}/${tab}`);
    }
  });

  test('an old link to one connector, to Secrets or to Scheduled opens on the Tools tab with its target', () => {
    const connector = routeSelection(`#/${AGENT}/connector/${AGENT}`);
    expect(connector).toEqual({ kind: 'tools', project: AGENT, connector: AGENT });
    expect(agentTabOf(connector.kind).id).toBe('tools');
    expect(routeHash(connector)).toEndWith(`/${AGENT}/connector/${AGENT}`);
    for (const old of ['/secrets', '/scheduled']) expect(agentTabOf(routeSelection(`#/${AGENT}${old}`).kind).id).toBe('tools');
    expect(routeSelection(`#/${AGENT}/scheduled/timer%3Amemory-daily.timer`)).toEqual({ kind: 'scheduled-job', project: AGENT, id: 'timer:memory-daily.timer' });
  });

  test('a tab opens its first page, and only that first page hides its own title', () => {
    for (const tab of AGENT_TABS) {
      const target = tab.target(AGENT);
      expect(agentTabOf(target.kind).id).toBe(tab.id);
      const first = shallowPages(tab)[0];
      if (first !== undefined) expect(first.target(AGENT)).toEqual(target);
    }
    expect(isPageRoot({ kind: 'chats', project: AGENT })).toBe(true);
    expect(isPageRoot({ kind: 'station', project: AGENT, accountId: 'a1' })).toBe(false);
    expect(isPageRoot({ kind: 'skill', project: AGENT, id: 'user:x' })).toBe(false);
    expect(isPageRoot({ kind: 'home', project: AGENT })).toBe(false);
    expect(isPageRoot({ kind: 'run', project: AGENT })).toBe(false);
    expect(isPageRoot({ kind: 'servers' })).toBe(false);
  });

  test('each tab shows one page switch at most, and only Memory has more than one page', () => {
    const shown = Object.fromEntries(AGENT_TABS.map((tab) => [tab.id, shallowPages(tab).map((page) => page.label)]));
    expect(shown).toEqual({ home: [], chats: ['Chats'], memory: ['Notes', 'Files', 'Skills'], tools: ['Tools'], settings: ['Settings'] });
  });

  test('deeper pages open with crumbs and a title instead of the agent header', () => {
    const deep: Selection[] = [
      { kind: 'station', project: AGENT, accountId: 'a1', rule: 'write' },
      { kind: 'voice', project: AGENT },
      { kind: 'sessions', project: AGENT, claudeProject: null, id: null },
      { kind: 'memory', project: AGENT, claudeProject: 'p', file: 'people/less.md' },
      { kind: 'skill', project: AGENT, id: 'user:x' },
      { kind: 'scheduled-job', project: AGENT, id: 'cron-agent:1' },
      { kind: 'model', project: AGENT },
      { kind: 'claude', project: AGENT },
      { kind: 'server', project: AGENT },
      { kind: 'run', project: AGENT },
      { kind: 'run', project: AGENT, view: 'helper', id: 'task-1' },
      { kind: 'backup', project: AGENT },
      { kind: 'agent-profile', project: AGENT },
      { kind: 'launch-log', project: AGENT },
      { kind: 'skills-github', project: AGENT },
      { kind: 'secrets-recent', project: AGENT },
      { kind: 'add-chat', project: AGENT },
    ];
    for (const selection of deep) expect(isDeepPage(selection)).toBe(true);
    const shallow: Selection[] = [
      { kind: 'home', project: AGENT },
      { kind: 'chats', project: AGENT },
      { kind: 'memory', project: AGENT, claudeProject: null, file: null },
      { kind: 'memory', project: AGENT, claudeProject: 'p', file: 'people' },
      { kind: 'skills', project: AGENT },
      { kind: 'tools', project: AGENT },
      { kind: 'agent-settings', project: AGENT },
      { kind: 'servers' },
    ];
    for (const selection of shallow) expect(isDeepPage(selection)).toBe(false);
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
    expect(phoneBackOf({ kind: 'org-route' })).toEqual({ kind: 'org-models' });
    expect(phoneBackOf({ kind: 'org-model', id: AGENT })).toEqual({ kind: 'org-models' });
    expect(shellSectionOf({ kind: 'org-model', id: AGENT })).toBe('models');
    expect(phoneBackOf({ kind: 'settings' })).toEqual({ kind: 'organization' });
  });
});

describe('setup flows open full screen, like the launch', () => {
  test('adding a chat, a model account or an AWS account is a focus page, and nothing else is', () => {
    const focus: Selection[] = [
      { kind: 'add-chat', project: AGENT },
      { kind: 'add-chat', project: AGENT, station: 'xmtp' },
      { kind: 'org-model-add' },
      { kind: 'org-model-add', provider: 'codex' },
      { kind: 'org-model-sign-in', id: AGENT },
      { kind: 'org-aws' },
    ];
    for (const selection of focus) expect(isFocusPage(selection)).toBe(true);
    const shell: Selection[] = [{ kind: 'chats', project: AGENT }, { kind: 'backup', project: AGENT }, { kind: 'run', project: AGENT, view: 'session' }, { kind: 'org-models' }, { kind: 'organization' }, { kind: 'launch' }];
    for (const selection of shell) expect(isFocusPage(selection)).toBe(false);
  });

  test('a focus page belongs to its section and goes back to where it was opened from', () => {
    expect(shellSectionOf({ kind: 'org-model-add' })).toBe('models');
    expect(shellSectionOf({ kind: 'org-aws' })).toBe('organization');
    expect(phoneBackOf({ kind: 'org-model-add', provider: 'codex' })).toEqual({ kind: 'org-models' });
    expect(phoneBackOf({ kind: 'org-model-sign-in', id: AGENT })).toEqual({ kind: 'org-model', id: AGENT });
    expect(phoneBackOf({ kind: 'org-aws' })).toEqual({ kind: 'organization' });
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
