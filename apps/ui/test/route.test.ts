import { describe, expect, test } from 'bun:test';
import { routeHash, routeSelection } from '../src/route';
import { type Selection } from '../src/components/selection';

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
    expect(routeHash({ kind: 'server', project: 'aB3-_xYz9Qw' })).toBe('#/aB3-_xYz9Qw/server');
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
});
