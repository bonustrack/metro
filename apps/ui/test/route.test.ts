import { describe, expect, test } from 'bun:test';
import { routeHash, routeSelection } from '../src/route.js';
import { sameViewOn, type Selection } from '../src/components/selection.js';
import { routedOrganization, splitOrganization } from '../src/auth/org-route.js';
import { routedDaemon, routedSegment } from '../src/auth/daemon.js';
import { installTestAccount, TEST_ORGANIZATION } from './account-fixture.js';
import { storeAccount } from '../src/auth/account.js';
import { forgetAgents, rememberAgents } from '../src/auth/agent-route.js';

const HOSTS = ['127.0.0.1:8420', 'localhost:8421', 'jelsoft-chan-rooms.tail1234.ts.net', 'suzy.tail1234.ts.net'];

describe('the first segment is the daemon', () => {
  test('every page round-trips for every kind of host', () => {
    for (const project of HOSTS) {
      const cases: Selection[] = [
        { kind: 'home', project },
        { kind: 'stations', project },
        { kind: 'station', project, accountId: 'a1-e5036b5f' },
        { kind: 'connectors', project },
        { kind: 'connector', project, id: 'aB3-_xYz9Qw' },
        { kind: 'sessions', project, claudeProject: null, id: null },
        { kind: 'sessions', project, claudeProject: '-home-me-proj', id: null },
        { kind: 'sessions', project, claudeProject: '-home-me-proj', id: '11111111-2222-4333-8444-555555555555' },
        { kind: 'memory', project, claudeProject: null, file: null },
        { kind: 'claude', project },
        { kind: 'skills', project },
        { kind: 'skill', project, id: 'user:write-as-less' },
        { kind: 'skill', project, id: '-Users-less-Cursor-bonustrack-metro:ship-it' },
        { kind: 'memory', project, claudeProject: '-Users-less-Cursor-bonustrack-metro', file: 'project_cli_redesign.md' },
      ];
      for (const selection of cases) expect(routeSelection(routeHash(selection))).toEqual(selection);
    }
    expect(routeHash({ kind: 'connectors', project: 'x.tail1234.ts.net' })).toBe('#/x.tail1234.ts.net/connectors');
    expect(routeHash({ kind: 'home', project: '127.0.0.1:8420' })).toBe('#/127.0.0.1:8420');
    expect(routeSelection('#/127.0.0.1:8420/')).toEqual({ kind: 'home', project: '127.0.0.1:8420' });
  });

  test('the fixed pages win over a host that happens to spell their name', () => {
    expect(routeSelection('#/docs/setup')).toEqual({ kind: 'docs' });
    expect(routeSelection('#/settings')).toEqual({ kind: 'settings' });
    expect(routeSelection('#/admin')).toEqual({ kind: 'admin' });
    expect(routeHash({ kind: 'admin' })).toBe('#/admin');
    expect(routeSelection('#/admin/users')).toEqual({ kind: 'admin-users' });
    expect(routeSelection('#/admin/organizations')).toEqual({ kind: 'admin-organizations' });
    expect(routeHash({ kind: 'admin-agents' })).toBe('#/admin/agents');
    expect(routeSelection('#/connect')).toEqual({ kind: 'connect' });
    expect(routeSelection('#/connect/http%3A%2F%2F127.0.0.1%3A8420')).toEqual({ kind: 'none' });
    expect(routeSelection('#/login')).toEqual({ kind: 'none' });
    expect(routeSelection('#/login?redirect=%2Fhost.example.com')).toEqual({ kind: 'none' });
    expect(routeHash({ kind: 'docs' })).toBe('#/docs/setup');
    expect(routeHash({ kind: 'connect' })).toBe('#/connect');
  });

  test('the root is the server list, and a server id is a first segment like a host', () => {
    for (const root of ['#/', '#', '']) expect(routeSelection(root)).toEqual({ kind: 'servers' });
    expect(routeHash({ kind: 'servers' })).toBe('#/');
    expect(routeSelection('#/aB3-_xYz9Qw')).toEqual({ kind: 'home', project: 'aB3-_xYz9Qw' });
    expect(routeSelection('#/aB3-_xYz9Qw/channels')).toEqual({ kind: 'stations', project: 'aB3-_xYz9Qw' });
    expect(routeSelection('#/aB3-_xYz9Qw/server')).toEqual({ kind: 'server', project: 'aB3-_xYz9Qw' });
    expect(routeSelection('#/aB3-_xYz9Qw/settings')).toEqual({ kind: 'agent-settings', project: 'aB3-_xYz9Qw' });
    expect(routeHash({ kind: 'agent-settings', project: 'aB3-_xYz9Qw' })).toBe('#/aB3-_xYz9Qw/settings');
    expect(routeHash({ kind: 'server', project: 'aB3-_xYz9Qw' })).toBe('#/aB3-_xYz9Qw/server');
    expect(routeSelection('#/aB3-_xYz9Qw/terminal')).toEqual({ kind: 'terminal', project: 'aB3-_xYz9Qw' });
    expect(routeHash({ kind: 'terminal', project: 'aB3-_xYz9Qw' })).toBe('#/aB3-_xYz9Qw/terminal');
    expect(routeHash({ kind: 'connectors', project: 'aB3-_xYz9Qw' })).toBe('#/aB3-_xYz9Qw/connectors');
  });

  test('what is not a route', () => {
    for (const bad of [
      '#/host with space/connectors',
      '#/x.tail1234.ts.net/agents',
      '#/x.tail1234.ts.net/agent/aB3-_xYz9Qw',
      '#/x.tail1234.ts.net/members',
      '#/x.tail1234.ts.net/connector/short',
      '#/x.tail1234.ts.net/channel/../etc',
      '#/x.tail1234.ts.net/memory/-x/notes.txt',
      '#/x.tail1234.ts.net/sessions/-x/id with space',
      '#/-leadingdash/connectors',
    ])
      expect(routeSelection(bad)).toEqual({ kind: 'none' });
  });

  test('routeHash of a selection without a project falls back to the root', () => {
    expect(routeHash({ kind: 'none' })).toBe('#/');
  });

  test('#/launch is a page of its own', () => {
    expect(routeSelection('#/launch')).toEqual({ kind: 'launch' });
    expect(routeSelection('#/members')).toEqual({ kind: 'members' });
    expect(routeHash({ kind: 'members' })).toBe('#/members');
    expect(routeSelection('#/organization')).toEqual({ kind: 'organization' });
    expect(routeHash({ kind: 'organization' })).toBe('#/organization');
    expect(routeHash({ kind: 'launch' })).toBe('#/launch');
    expect(routeSelection('#/launch/').kind).not.toBe('launch');
  });
});

describe('switching server keeps the page', () => {
  test('a page of the box carries over, and anything that names a thing on the old box falls back to its list', () => {
    const on = (selection: Selection): string => routeHash(sameViewOn(selection, 'suzy00000001'));
    expect(on({ kind: 'terminal', project: 'lisa000000001' })).toBe('#/suzy00000001/terminal');
    expect(on({ kind: 'model', project: 'lisa000000001' })).toBe('#/suzy00000001/model');
    expect(on({ kind: 'claude', project: 'lisa000000001' })).toBe('#/suzy00000001/harness');
    expect(routeSelection('#/suzy00000001/claude')).toEqual({ kind: 'claude', project: 'suzy00000001' });
    expect(on({ kind: 'home', project: 'lisa000000001' })).toBe('#/suzy00000001');
    expect(on({ kind: 'station', project: 'lisa000000001', accountId: 'a1' })).toBe('#/suzy00000001/channels');
    expect(on({ kind: 'connector', project: 'lisa000000001', id: 'c1' })).toBe('#/suzy00000001/connectors');
    expect(on({ kind: 'skill', project: 'lisa000000001', id: 'user:x' })).toBe('#/suzy00000001/skills');
    expect(on({ kind: 'sessions', project: 'lisa000000001', claudeProject: 'p', id: 's' })).toBe('#/suzy00000001/sessions');
    expect(on({ kind: 'memory', project: 'lisa000000001', claudeProject: 'p', file: 'f.md' })).toBe('#/suzy00000001/memory');
    expect(on({ kind: 'servers' })).toBe('#/suzy00000001');
  });
});

describe('the organization rides in front of every route but settings and docs', () => {
  test('an organization id is split off the hash and remembered; a host or an agent id is not', () => {
    expect(splitOrganization('#/org_01ABCDEFGHIJKLMNOPQRSTUVWX/members')).toEqual({ organization: 'org_01ABCDEFGHIJKLMNOPQRSTUVWX', rest: '#/members' });
    expect(splitOrganization('#/org_01ABCDEFGHIJKLMNOPQRSTUVWX')).toEqual({ organization: 'org_01ABCDEFGHIJKLMNOPQRSTUVWX', rest: '#/' });
    expect(splitOrganization('#/aB3-_xYz9Qw/server')).toEqual({ organization: null, rest: '#/aB3-_xYz9Qw/server' });
    expect(splitOrganization('#/x.tail1234.ts.net')).toEqual({ organization: null, rest: '#/x.tail1234.ts.net' });
    expect(routeSelection('#/org_01ABCDEFGHIJKLMNOPQRSTUVWX/members')).toEqual({ kind: 'members' });
    expect(routedOrganization()).toBe('org_01ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(routeSelection('#/org_01ABCDEFGHIJKLMNOPQRSTUVWX/aB3-_xYz9Qw/channels')).toEqual({ kind: 'stations', project: 'aB3-_xYz9Qw' });
    expect(routeSelection('#/settings')).toEqual({ kind: 'settings' });
    expect(routedOrganization()).toBeNull();
    expect(routedDaemon('#/org_01ABCDEFGHIJKLMNOPQRSTUVWX/aB3-_xYz9Qw/server')).toBeNull();
    expect(routedSegment('#/org_01ABCDEFGHIJKLMNOPQRSTUVWX/aB3-_xYz9Qw/server')).toBe('aB3-_xYz9Qw');
    expect(routedDaemon('#/org_01ABCDEFGHIJKLMNOPQRSTUVWX')).toBeNull();
    expect(routedDaemon('#/org_01ABCDEFGHIJKLMNOPQRSTUVWX/x.tail1234.ts.net')).toBe('https://x.tail1234.ts.net');
    expect(routedDaemon('#/stage-labs/tony/server')).toBeNull();
    expect(routedDaemon('#/stage-labs/tony')).toBeNull();
    expect(routedDaemon('#/stage-labs/127.0.0.1:8420')).toBe('http://127.0.0.1:8420');
  });

  test('routeHash prefixes the routed organization, else the account one, and never the global pages', () => {
    routeSelection('#/org_01ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(routeHash({ kind: 'servers' })).toBe('#/org_01ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(routeHash({ kind: 'members' })).toBe('#/org_01ABCDEFGHIJKLMNOPQRSTUVWX/members');
    expect(routeHash({ kind: 'launch' })).toBe('#/org_01ABCDEFGHIJKLMNOPQRSTUVWX/launch');
    expect(routeHash({ kind: 'server', project: 'aB3-_xYz9Qw' })).toBe('#/org_01ABCDEFGHIJKLMNOPQRSTUVWX/aB3-_xYz9Qw/server');
    expect(routeHash({ kind: 'settings' })).toBe('#/settings');
    routeSelection('#/settings');
    installTestAccount();
    expect(routeHash({ kind: 'servers' })).toBe(`#/${TEST_ORGANIZATION}`);
    expect(routeHash({ kind: 'connectors', project: 'aB3-_xYz9Qw' })).toBe(`#/${TEST_ORGANIZATION}/aB3-_xYz9Qw/connectors`);
  });

  test('a slug is an organization segment too, and the account slug wins over the id in every hash', () => {
    expect(splitOrganization('#/stage-labs/members')).toEqual({ organization: 'stage-labs', rest: '#/members' });
    expect(splitOrganization('#/members')).toEqual({ organization: null, rest: '#/members' });
    expect(splitOrganization('#/settings')).toEqual({ organization: null, rest: '#/settings' });
    expect(splitOrganization('#/aB3-_xYz9Qw/server')).toEqual({ organization: null, rest: '#/aB3-_xYz9Qw/server' });
    expect(routeSelection('#/stage-labs/aB3-_xYz9Qw/server')).toEqual({ kind: 'server', project: 'aB3-_xYz9Qw' });
    storeAccount({ ...installTestAccount(), organizationSlug: 'stage-labs' });
    expect(routeHash({ kind: 'members' })).toBe('#/stage-labs/members');
    routeSelection(`#/${TEST_ORGANIZATION}/members`);
    expect(routeHash({ kind: 'members' })).toBe('#/stage-labs/members');
    routeSelection('#/other-org/members');
    expect(routeHash({ kind: 'members' })).toBe('#/other-org/members');
    routeSelection('#/settings');
  });

  test('an agent with a known slug is addressed by it, and an unknown id or a slug passes through as given', () => {
    storeAccount({ ...installTestAccount(), organizationSlug: 'stage-labs' });
    rememberAgents([{ id: 'aB3-_xYz9Qw', slug: 'tony' }, { id: 'zz9-_xYz9Qw', slug: null }]);
    expect(routeHash({ kind: 'server', project: 'aB3-_xYz9Qw' })).toBe('#/stage-labs/tony/server');
    expect(routeHash({ kind: 'home', project: 'zz9-_xYz9Qw' })).toBe('#/stage-labs/zz9-_xYz9Qw');
    expect(routeSelection('#/stage-labs/tony/channels')).toEqual({ kind: 'stations', project: 'tony' });
    forgetAgents();
    expect(routeHash({ kind: 'server', project: 'aB3-_xYz9Qw' })).toBe('#/stage-labs/aB3-_xYz9Qw/server');
    routeSelection('#/settings');
  });
});

describe('a connector link the daemon builds without an organization or an agent', () => {
  test('opens that connector on the agent this browser used last, not a "not a member" page', () => {
    const saved = new Map<string, string>([['metro.server', 'agent000001']]);
    const holder = globalThis as { window?: unknown };
    const before = holder.window;
    holder.window = { localStorage: { getItem: (k: string) => saved.get(k) ?? null } };
    expect(splitOrganization('#/connector/conn0000001').organization).toBeNull();
    expect(routeSelection('#/connector/conn0000001')).toEqual({ kind: 'connector', project: 'agent000001', id: 'conn0000001' });
    expect(routeSelection('#/connectors')).toEqual({ kind: 'connectors', project: 'agent000001' });
    holder.window = before;
    expect(routeSelection('#/connector/conn0000001')).toEqual({ kind: 'none' });
  });
});
