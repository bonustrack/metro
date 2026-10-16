import { beforeEach, describe, expect, test } from 'bun:test';
import { currentSelection, routeHash, routeSelection } from '../src/route.js';
import { configurePlatform, location, memoryKeyValue, type Location } from '../src/platform.js';
import { sameViewOn, type Selection } from '../src/selection.js';
import { noteRoutedOrganization, routedOrganization, splitOrganization } from '../src/auth/org-route.js';
import { routedDaemon, routedSegment } from '../src/auth/daemon.js';
import { installTestAccount, TEST_ORGANIZATION } from './account-fixture.js';
import { clearAccount, storeAccount } from '../src/auth/account.js';
import { forgetAgents, rememberAgents } from '../src/auth/agent-route.js';

beforeEach(() => {
  clearAccount();
  noteRoutedOrganization(null);
});

const HOSTS = ['127.0.0.1:8420', 'localhost:8421', 'jelsoft-chan-rooms.tail1234.ts.net', 'suzy.tail1234.ts.net'];

describe('the first segment is the daemon', () => {
  test('every page round-trips for every kind of host', () => {
    for (const project of HOSTS) {
      const cases: Selection[] = [
        { kind: 'home', project },
        { kind: 'run', project },
        { kind: 'chats', project },
        { kind: 'station', project, accountId: 'a1-e5036b5f' },
        { kind: 'station', project, accountId: 'a1-e5036b5f', rule: 'write' },
        { kind: 'station', project, accountId: 'a1', rule: 'exceptions' },
        { kind: 'station', project, accountId: 'a1', rule: 'exceptions/close_channel' },
        { kind: 'station', project, accountId: 'a1', rule: 'exceptions/notion.search' },
        { kind: 'station', project, accountId: 'a1', rule: 'exceptions/gmail:send/draft' },
        { kind: 'tools', project },
        { kind: 'tools', project, connector: 'aB3-_xYz9Qw' },
        { kind: 'sessions', project, claudeProject: null, id: null },
        { kind: 'sessions', project, claudeProject: '-home-me-proj', id: null },
        { kind: 'sessions', project, claudeProject: '-home-me-proj', id: '11111111-2222-4333-8444-555555555555' },
        { kind: 'memory', project, claudeProject: null, file: null },
        { kind: 'claude', project },
        { kind: 'skills', project },
        { kind: 'scheduled', project },
        { kind: 'scheduled-job', project, id: 'cron-agent:0123abcd' },
        { kind: 'scheduled-job', project, id: 'timer:memory-daily.timer' },
        { kind: 'skill', project, id: 'user:write-as-less' },
        { kind: 'skill', project, id: '-Users-less-Cursor-bonustrack-metro:ship-it' },
        { kind: 'memory', project, claudeProject: '-Users-less-Cursor-bonustrack-metro', file: 'project_cli_redesign.md' },
        { kind: 'memory', project, claudeProject: '-root', file: 'entities/people/less.md' },
        { kind: 'memory', project, claudeProject: '-root', file: 'entities/people' },
        { kind: 'files', project, path: '' },
        { kind: 'secrets', project },
        { kind: 'voice', project },
        { kind: 'files', project, path: 'work/my notes/a#b.md' },
      ];
      for (const selection of cases) expect(routeSelection(routeHash(selection))).toEqual(selection);
    }
    expect(routeHash({ kind: 'tools', project: 'x.tail1234.ts.net' })).toBe('#/x.tail1234.ts.net/tools');
    expect(routeHash({ kind: 'station', project: 'x.tail1234.ts.net', accountId: 'a1', rule: 'exceptions/gmail:send/draft' })).toBe('#/x.tail1234.ts.net/channel/a1/exceptions/gmail%3Asend%2Fdraft');
    expect(routeSelection('#/x.tail1234.ts.net/channel/a1/exceptions/notion.search')).toEqual({ kind: 'station', project: 'x.tail1234.ts.net', accountId: 'a1', rule: 'exceptions/notion.search' });
    expect(routeSelection('#/x.tail1234.ts.net/channel/a1/exceptions/%E0%A4%A')).toEqual({ kind: 'station', project: 'x.tail1234.ts.net', accountId: 'a1', rule: 'exceptions/%E0%A4%A' });
    expect(routeHash({ kind: 'home', project: '127.0.0.1:8420' })).toBe('#/127.0.0.1:8420');
    expect(routeSelection('#/127.0.0.1:8420/')).toEqual({ kind: 'home', project: '127.0.0.1:8420' });
  });

  test('the fixed pages win over a host that happens to spell their name', () => {
    expect(routeSelection('#/settings')).toEqual({ kind: 'settings' });
    expect(routeSelection('#/admin')).toEqual({ kind: 'admin' });
    expect(routeHash({ kind: 'admin' })).toBe('#/admin');
    expect(routeSelection('#/admin/users')).toEqual({ kind: 'admin-users' });
    expect(routeSelection('#/admin/organizations')).toEqual({ kind: 'admin-organizations' });
    expect(routeHash({ kind: 'admin-agents' })).toBe('#/admin/agents');
    expect(routeSelection('#/admin/users/user_01HXYZ')).toEqual({ kind: 'admin-user', id: 'user_01HXYZ' });
    expect(routeHash({ kind: 'admin-user', id: 'user_01HXYZ' })).toBe('#/admin/users/user_01HXYZ');
    expect(routeSelection('#/admin/organizations/org_01FIXTUREORG00000')).toEqual({ kind: 'admin-organization', id: 'org_01FIXTUREORG00000' });
    expect(routeHash({ kind: 'admin-organization', id: 'org_01FIXTUREORG00000' })).toBe('#/admin/organizations/org_01FIXTUREORG00000');
    expect(routeSelection('#/admin/users/a/b')).toEqual({ kind: 'none' });
    expect(routeSelection('#/connect')).toEqual({ kind: 'none' });
    expect(routeSelection('#/connect/http%3A%2F%2F127.0.0.1%3A8420')).toEqual({ kind: 'none' });
    expect(routeSelection('#/login')).toEqual({ kind: 'none' });
    expect(routeSelection('#/login?redirect=%2Fhost.example.com')).toEqual({ kind: 'none' });
  });

  test('the root is the server list, and a server id is a first segment like a host', () => {
    for (const root of ['#/', '#', '', '/']) expect(routeSelection(root)).toEqual({ kind: 'servers' });
    expect(routeHash({ kind: 'servers' })).toBe('#/');
    expect(routeSelection('#/aB3-_xYz9Qw')).toEqual({ kind: 'home', project: 'aB3-_xYz9Qw' });
    expect(routeSelection('#/aB3-_xYz9Qw/channels')).toEqual({ kind: 'chats', project: 'aB3-_xYz9Qw' });
    expect(routeSelection('#/aB3-_xYz9Qw/server')).toEqual({ kind: 'server', project: 'aB3-_xYz9Qw' });
    expect(routeSelection('#/aB3-_xYz9Qw/settings')).toEqual({ kind: 'agent-settings', project: 'aB3-_xYz9Qw' });
    expect(routeHash({ kind: 'agent-settings', project: 'aB3-_xYz9Qw' })).toBe('#/aB3-_xYz9Qw/settings');
    expect(routeHash({ kind: 'server', project: 'aB3-_xYz9Qw' })).toBe('#/aB3-_xYz9Qw/server');
    expect(routeSelection('#/aB3-_xYz9Qw/terminal')).toEqual({ kind: 'terminal', project: 'aB3-_xYz9Qw' });
    expect(routeHash({ kind: 'terminal', project: 'aB3-_xYz9Qw' })).toBe('#/aB3-_xYz9Qw/terminal');
    expect(routeHash({ kind: 'tools', project: 'aB3-_xYz9Qw' })).toBe('#/aB3-_xYz9Qw/tools');
  });

  test('Run stays scoped through slugs and agent switching', () => {
    expect(routeSelection('#/demo-agent/run')).toEqual({ kind: 'run', project: 'demo-agent' });
    expect(routeSelection('#/demo-org/demo-agent/run')).toEqual({ kind: 'run', project: 'demo-agent' });
    expect(routeHash({ kind: 'run', project: 'demo-agent' })).toBe('#/demo-org/demo-agent/run');
    expect(sameViewOn({ kind: 'run', project: 'agent-one' }, 'agent-two')).toEqual({ kind: 'run', project: 'agent-two' });
  });

  test('an agent slug named run remains scoped to the known organization', () => {
    storeAccount({ ...installTestAccount(), organizationSlug: 'demo-org' });
    for (const organization of ['demo-org', TEST_ORGANIZATION]) {
      expect(splitOrganization(`#/${organization}/run`)).toEqual({ organization, rest: '#/run' });
      expect(routeSelection(`#/${organization}/run`)).toEqual({ kind: 'home', project: 'run' });
      expect(routeSelection(`#/${organization}/run/run`)).toEqual({ kind: 'run', project: 'run' });
      expect(routeSelection(`#/${organization}/run/server`)).toEqual({ kind: 'server', project: 'run' });
      expect(routedSegment(`#/${organization}/run/run`)).toBe('run');
    }
    const selection: Selection = { kind: 'run', project: 'run' };
    expect(routeHash(selection)).toBe('#/demo-org/run/run');
    expect(routeSelection(routeHash(selection))).toEqual(selection);
    expect(sameViewOn({ kind: 'run', project: 'another-agent' }, 'run')).toEqual(selection);
    expect(routeSelection('#/another-agent/run')).toEqual({ kind: 'run', project: 'another-agent' });
  });

  test('what is not a route', () => {
    for (const bad of [
      '#/host with space/connectors',
      '#/x.tail1234.ts.net/agents',
      '#/x.tail1234.ts.net/agent/aB3-_xYz9Qw',
      '#/x.tail1234.ts.net/members',
      '#/x.tail1234.ts.net/connector/short',
      '#/x.tail1234.ts.net/channel/../etc',
      '#/x.tail1234.ts.net/channel/a1/send',
      '#/x.tail1234.ts.net/channel/a1/exceptions/a b',
      '#/x.tail1234.ts.net/memory/-x/a b',
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

  test('the organization Connectors page and one connector of it are organization pages', () => {
    expect(routeSelection('#/organization/connectors')).toEqual({ kind: 'org-connectors' });
    expect(routeHash({ kind: 'org-connectors' })).toBe('#/organization/connectors');
    expect(routeSelection('#/organization/connectors/aB3-_xYz9Qw')).toEqual({ kind: 'org-connector', id: 'aB3-_xYz9Qw' });
    expect(routeSelection('#/organization/connectors/aB3-_xYz9Qw?org_connector=handoff')).toEqual({ kind: 'org-connector', id: 'aB3-_xYz9Qw' });
    expect(routeHash({ kind: 'org-connector', id: 'aB3-_xYz9Qw' })).toBe('#/organization/connectors/aB3-_xYz9Qw');
    expect(routeSelection('#/organization/connectors/not-an-id').kind).toBe('none');
    storeAccount({ ...installTestAccount(), organizationSlug: 'stage-labs' });
    expect(routeSelection('#/stage-labs/organization/connectors')).toEqual({ kind: 'org-connectors' });
    expect(routeSelection('#/stage-labs/organization/connectors/aB3-_xYz9Qw')).toEqual({ kind: 'org-connector', id: 'aB3-_xYz9Qw' });
    expect(routeHash({ kind: 'org-connector', id: 'aB3-_xYz9Qw' })).toBe('#/stage-labs/organization/connectors/aB3-_xYz9Qw');
    expect(routeSelection('#/stage-labs/aB3-_xYz9Qw/connectors')).toEqual({ kind: 'tools', project: 'aB3-_xYz9Qw' });
  });

  test('the organization Models page is an organization page, and an agent keeps its own Model page', () => {
    storeAccount({ ...installTestAccount(), organizationSlug: null });
    expect(routeSelection('#/organization/models')).toEqual({ kind: 'org-models' });
    expect(routeHash({ kind: 'org-models' })).toEndWith('/organization/models');
    expect(routeSelection('#/organization/models/x').kind).toBe('none');
    expect(routeSelection('#/organization/models?openrouter=orA00000001')).toEqual({ kind: 'org-models' });
    expect(routeSelection('#/organization/models/default')).toEqual({ kind: 'org-route' });
    expect(routeSelection('#/organization/models/aB3-_xYz9Qw')).toEqual({ kind: 'org-model', id: 'aB3-_xYz9Qw' });
    storeAccount({ ...installTestAccount(), organizationSlug: 'stage-labs' });
    expect(routeHash({ kind: 'org-route' })).toBe('#/stage-labs/organization/models/default');
    expect(routeHash({ kind: 'org-model', id: 'aB3-_xYz9Qw' })).toBe('#/stage-labs/organization/models/aB3-_xYz9Qw');
    expect(routeSelection('#/stage-labs/organization/models/aB3-_xYz9Qw')).toEqual({ kind: 'org-model', id: 'aB3-_xYz9Qw' });
    expect(routeSelection('#/stage-labs/organization/models')).toEqual({ kind: 'org-models' });
    expect(routeHash({ kind: 'org-models' })).toBe('#/stage-labs/organization/models');
    expect(routeSelection('#/stage-labs/aB3-_xYz9Qw/model')).toEqual({ kind: 'model', project: 'aB3-_xYz9Qw' });
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
    expect(on({ kind: 'station', project: 'lisa000000001', accountId: 'a1' })).toBe('#/suzy00000001/chats');
    expect(on({ kind: 'station', project: 'lisa000000001', accountId: 'a1', rule: 'delete' })).toBe('#/suzy00000001/chats');
    expect(on({ kind: 'tools', project: 'lisa000000001' })).toBe('#/suzy00000001/tools');
    expect(on({ kind: 'skill', project: 'lisa000000001', id: 'user:x' })).toBe('#/suzy00000001/skills');
    expect(on({ kind: 'sessions', project: 'lisa000000001', claudeProject: 'p', id: 's' })).toBe('#/suzy00000001/sessions');
    expect(on({ kind: 'memory', project: 'lisa000000001', claudeProject: 'p', file: 'f.md' })).toBe('#/suzy00000001/memory');
    expect(on({ kind: 'servers' })).toBe('#/suzy00000001');
  });
});

describe('the organization rides in front of every scoped route', () => {
  test('an organization id is split off the hash and remembered; a host or an agent id is not', () => {
    expect(splitOrganization('#/org_01ABCDEFGHIJKLMNOPQRSTUVWX/members')).toEqual({ organization: 'org_01ABCDEFGHIJKLMNOPQRSTUVWX', rest: '#/members' });
    expect(splitOrganization('#/org_01ABCDEFGHIJKLMNOPQRSTUVWX')).toEqual({ organization: 'org_01ABCDEFGHIJKLMNOPQRSTUVWX', rest: '#/' });
    expect(splitOrganization('#/aB3-_xYz9Qw/server')).toEqual({ organization: null, rest: '#/aB3-_xYz9Qw/server' });
    expect(splitOrganization('#/x.tail1234.ts.net')).toEqual({ organization: null, rest: '#/x.tail1234.ts.net' });
    expect(routeSelection('#/org_01ABCDEFGHIJKLMNOPQRSTUVWX/members')).toEqual({ kind: 'members' });
    expect(routedOrganization()).toBe('org_01ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(routeSelection('#/org_01ABCDEFGHIJKLMNOPQRSTUVWX/aB3-_xYz9Qw/channels')).toEqual({ kind: 'chats', project: 'aB3-_xYz9Qw' });
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
    expect(routeHash({ kind: 'tools', project: 'aB3-_xYz9Qw' })).toBe(`#/${TEST_ORGANIZATION}/aB3-_xYz9Qw/tools`);
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
    expect(routeSelection('#/stage-labs/tony/channels')).toEqual({ kind: 'chats', project: 'tony' });
    forgetAgents();
    expect(routeHash({ kind: 'server', project: 'aB3-_xYz9Qw' })).toBe('#/stage-labs/aB3-_xYz9Qw/server');
    routeSelection('#/settings');
  });
});

describe('the agent tabs have their own addresses, and the old ones lead to them', () => {
  test('Chats and Tools round-trip, with and without an organization in front', () => {
    expect(routeSelection('#/aB3-_xYz9Qw/chats')).toEqual({ kind: 'chats', project: 'aB3-_xYz9Qw' });
    expect(routeSelection('#/aB3-_xYz9Qw/tools')).toEqual({ kind: 'tools', project: 'aB3-_xYz9Qw' });
    expect(routeSelection('#/stage-labs/tony/chats')).toEqual({ kind: 'chats', project: 'tony' });
    expect(routeSelection('#/stage-labs/tony/tools')).toEqual({ kind: 'tools', project: 'tony' });
    expect(splitOrganization('#/tony/chats').organization).toBeNull();
    expect(splitOrganization('#/tony/tools').organization).toBeNull();
  });

  test('the old Channels and Connectors addresses open the tab, and the address is rewritten to it', () => {
    storeAccount({ ...installTestAccount(), organizationSlug: 'stage-labs' });
    const rewritten = (hash: string): string => routeHash(routeSelection(hash));
    expect(rewritten('#/stage-labs/tony/channels')).toBe('#/stage-labs/tony/chats');
    expect(rewritten('#/tony/channels')).toBe('#/stage-labs/tony/chats');
    expect(rewritten('#/stage-labs/tony/connectors')).toBe('#/stage-labs/tony/tools');
    expect(rewritten('#/stage-labs/tony/connector/aB3-_xYz9Qw')).toBe('#/stage-labs/tony/connector/aB3-_xYz9Qw');
    expect(routeSelection('#/stage-labs/tony/connector/aB3-_xYz9Qw')).toEqual({ kind: 'tools', project: 'tony', connector: 'aB3-_xYz9Qw' });
    expect(rewritten('#/stage-labs/tony/channel/a1')).toBe('#/stage-labs/tony/channel/a1');
    expect(rewritten('#/stage-labs/tony/settings')).toBe('#/stage-labs/tony/settings');
    routeSelection('#/settings');
  });
});

describe('a connector link the daemon builds without an organization or an agent', () => {
  test('opens that connector on the agent this device used last, not a "not a member" page', () => {
    configurePlatform({ kv: memoryKeyValue({ 'metro.server': 'agent000001' }) });
    expect(splitOrganization('#/connector/conn0000001').organization).toBeNull();
    expect(routeSelection('#/connector/conn0000001')).toEqual({ kind: 'tools', project: 'agent000001', connector: 'conn0000001' });
    expect(routeSelection('#/connectors')).toEqual({ kind: 'tools', project: 'agent000001' });
    configurePlatform({ kv: memoryKeyValue() });
    expect(routeSelection('#/connector/conn0000001')).toEqual({ kind: 'none' });
  });
});

describe('the current address comes from the platform location', () => {
  test('two organizations on the same page kind give two distinct selections', () => {
    const before = location();
    let hash = '#/stage';
    const fake: Location = { ...before, hash: () => hash };
    configurePlatform({ location: fake });
    const first = currentSelection();
    hash = '#/mci';
    const second = currentSelection();
    configurePlatform({ location: before });
    expect(first).toEqual({ kind: 'servers' });
    expect(second).toEqual({ kind: 'servers' });
    expect(first).not.toBe(second);
  });
});
