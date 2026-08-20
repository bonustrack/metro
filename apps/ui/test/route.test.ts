import { describe, expect, test } from 'bun:test';
import { routeHash, routeSelection } from '../src/route';

describe('routeSelection', () => {
  test('a per-agent route selects that agent by id', () => {
    expect(routeSelection('#/agent/1')).toEqual({ kind: 'agent', id: 1 });
    expect(routeSelection('#/agent/2')).toEqual({ kind: 'agent', id: 2 });
    expect(routeSelection('#/agent/4242')).toEqual({ kind: 'agent', id: 4242 });
  });

  test('a station route selects that account by its id', () => {
    expect(routeSelection('#/station/z01')).toEqual({
      kind: 'station',
      accountId: 'z01',
    });
    expect(routeSelection('#/station/a1-e5036b5f')).toEqual({
      kind: 'station',
      accountId: 'a1-e5036b5f',
    });
    expect(routeSelection('#/station/tony')).toEqual({
      kind: 'station',
      accountId: 'tony',
    });
  });

  test('a station id that could escape its own segment is not a route', () => {
    for (const bad of [
      '#/station',
      '#/station/',
      '#/station/a/b',
      '#/station/../agent/1',
      '#/station/a b',
      '#/station/a.b',
      '#/Station/z01',
      `#/station/${'z'.repeat(65)}`,
    ])
      expect(routeSelection(bad)).toEqual({ kind: 'none' });
  });

  test('the documentation page is its own path too', () => {
    expect(routeSelection('#/docs/setup')).toEqual({ kind: 'docs' });
  });

  test('the settings page is its own path too', () => {
    expect(routeSelection('#/settings')).toEqual({ kind: 'settings' });
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
      '#/agent/0',
      '#/agent/-1',
      '#/agent/01',
      '#/agent/1.0',
      '#/agent/1e3',
      '#/agent/ 1',
      '#/agent/1 ',
      '#/agent/abc',
      '#/agent/1/2',
      '#/agent/99999999999',
      '#/1',
      '#/agent',
      '#/agent/',
      '#/new',
      '#/New',
      '#/docs',
      '#/Docs/setup',
      '#/docs/setup/1',
      '#/setup',
      '#/Settings',
      '#/settings/1',
    ])
      expect(routeSelection(bad)).toEqual({ kind: 'none' });
  });
});

describe('routeHash', () => {
  test('a selected agent is reflected as its own url', () => {
    expect(routeHash({ kind: 'agent', id: 1 })).toBe('#/agent/1');
    expect(routeHash({ kind: 'agent', id: 2 })).toBe('#/agent/2');
  });

  test('a selected station is reflected as its own url', () => {
    expect(routeHash({ kind: 'station', accountId: 'z01' })).toBe('#/station/z01');
  });

  test('the create pane, the start page and the no-selection state have stable urls', () => {
    expect(routeHash({ kind: 'docs' })).toBe('#/docs/setup');
    expect(routeHash({ kind: 'settings' })).toBe('#/settings');
    expect(routeHash({ kind: 'none' })).toBe('#/');
  });

  test('every hash it writes parses back to the same selection', () => {
    for (const selection of [
      { kind: 'agent', id: 7 } as const,
      { kind: 'station', accountId: 'a1-e5036b5f' } as const,
      { kind: 'docs' } as const,
      { kind: 'settings' } as const,
      { kind: 'none' } as const,
    ])
      expect(routeSelection(routeHash(selection))).toEqual(selection);
  });
});
