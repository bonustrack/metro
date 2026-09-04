import { describe, expect, test } from 'bun:test';
import { routeHash, routeSelection } from '../src/route';
import { type Selection } from '../src/components/selection';

const HOSTS = ['127.0.0.1:8420', 'localhost:8421', 'jelsoft-chan-rooms.trycloudflare.com', 'suzy.tail1234.ts.net'];

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
    expect(routeHash({ kind: 'connectors', project: 'x.trycloudflare.com' })).toBe('#/x.trycloudflare.com/connectors');
    expect(routeHash({ kind: 'home', project: '127.0.0.1:8420' })).toBe('#/127.0.0.1:8420');
    expect(routeSelection('#/127.0.0.1:8420/')).toEqual({ kind: 'home', project: '127.0.0.1:8420' });
  });

  test('the fixed pages win over a host that happens to spell their name', () => {
    expect(routeSelection('#/docs/setup')).toEqual({ kind: 'docs' });
    expect(routeSelection('#/settings')).toEqual({ kind: 'settings' });
    expect(routeSelection('#/connect')).toEqual({ kind: 'connect', url: null });
    expect(routeSelection('#/connect/http%3A%2F%2F127.0.0.1%3A8420')).toEqual({ kind: 'connect', url: 'http://127.0.0.1:8420' });
    expect(routeSelection('#/login')).toEqual({ kind: 'none' });
    expect(routeSelection('#/authorize/aB3-_xYz9Qw')).toEqual({ kind: 'none' });
    expect(routeHash({ kind: 'docs' })).toBe('#/docs/setup');
    expect(routeHash({ kind: 'connect', url: 'http://127.0.0.1:8420' })).toBe('#/connect/http%3A%2F%2F127.0.0.1%3A8420');
  });

  test('what is not a route', () => {
    for (const bad of [
      '#/',
      '#',
      '',
      '#/host with space/connectors',
      '#/x.trycloudflare.com/agents',
      '#/x.trycloudflare.com/agent/aB3-_xYz9Qw',
      '#/x.trycloudflare.com/members',
      '#/x.trycloudflare.com/connector/short',
      '#/x.trycloudflare.com/station/../etc',
      '#/x.trycloudflare.com/memory/-x/notes.txt',
      '#/x.trycloudflare.com/sessions/-x/id with space',
      '#/-leadingdash/connectors',
    ])
      expect(routeSelection(bad)).toEqual({ kind: 'none' });
  });

  test('routeHash of a selection without a project falls back to the root', () => {
    expect(routeHash({ kind: 'none' })).toBe('#/');
  });
});
