import { describe, expect, test } from 'bun:test';
import { routeHash, routeSelection } from '../src/route.js';
import { sameViewOn, type Selection } from '../src/components/selection.js';

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
