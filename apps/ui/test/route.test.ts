import { describe, expect, test } from 'bun:test';
import { routeHash, routeSelection } from '../src/route';

describe('routeSelection', () => {
  test('a per-agent route selects that agent by id', () => {
    expect(routeSelection('#/1')).toEqual({ kind: 'agent', id: 1 });
    expect(routeSelection('#/2')).toEqual({ kind: 'agent', id: 2 });
    expect(routeSelection('#/4242')).toEqual({ kind: 'agent', id: 4242 });
  });

  test('the create route is its own path, never an agent id', () => {
    expect(routeSelection('#/new')).toEqual({ kind: 'new' });
  });

  test('the start-a-session page is its own path too', () => {
    expect(routeSelection('#/start')).toEqual({ kind: 'start' });
  });

  test('the subagent activity page is its own path as well', () => {
    expect(routeSelection('#/runs')).toEqual({ kind: 'runs' });
  });

  test('an empty or root hash is the no-selection state', () => {
    expect(routeSelection('')).toEqual({ kind: 'none' });
    expect(routeSelection('#')).toEqual({ kind: 'none' });
    expect(routeSelection('#/')).toEqual({ kind: 'none' });
  });

  test('the OAuth session fragment is never read as a route', () => {
    expect(routeSelection('#session=a.b.c')).toEqual({ kind: 'none' });
    expect(routeSelection('#error=exchange')).toEqual({ kind: 'none' });
  });

  test('anything that is not a plain positive id falls back to no selection', () => {
    for (const bad of [
      '#/0',
      '#/-1',
      '#/01',
      '#/1.0',
      '#/1e3',
      '#/ 1',
      '#/1 ',
      '#/abc',
      '#/1/2',
      '#/99999999999',
      '#/New',
      '#/Start',
      '#/start/1',
      '#/Runs',
      '#/runs/1',
    ])
      expect(routeSelection(bad)).toEqual({ kind: 'none' });
  });
});

describe('routeHash', () => {
  test('a selected agent is reflected as its own url', () => {
    expect(routeHash({ kind: 'agent', id: 1 })).toBe('#/1');
    expect(routeHash({ kind: 'agent', id: 2 })).toBe('#/2');
  });

  test('the create pane, the standalone pages and the no-selection state have stable urls', () => {
    expect(routeHash({ kind: 'new' })).toBe('#/new');
    expect(routeHash({ kind: 'start' })).toBe('#/start');
    expect(routeHash({ kind: 'runs' })).toBe('#/runs');
    expect(routeHash({ kind: 'none' })).toBe('#/');
  });

  test('every hash it writes parses back to the same selection', () => {
    for (const selection of [
      { kind: 'agent', id: 7 } as const,
      { kind: 'new' } as const,
      { kind: 'start' } as const,
      { kind: 'runs' } as const,
      { kind: 'none' } as const,
    ])
      expect(routeSelection(routeHash(selection))).toEqual(selection);
  });
});
