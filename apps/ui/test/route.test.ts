import { describe, expect, test } from 'bun:test';
import { routeHash, routeSelection } from '../src/route';

const PROJECT = 'prj00000001';

describe('routeSelection', () => {
  test('a per-agent route selects that agent by id', () => {
    expect(routeSelection('#/prj00000001/agent/id000000001')).toEqual({
      kind: 'agent',
      project: PROJECT,
      id: 'id000000001',
    });
    expect(routeSelection('#/prj00000001/agent/aB3-_xYz9Qw')).toEqual({
      kind: 'agent',
      project: PROJECT,
      id: 'aB3-_xYz9Qw',
    });
  });

  test('a station route selects that account by its id', () => {
    expect(routeSelection('#/prj00000001/station/z01')).toEqual({
      kind: 'station',
      project: PROJECT,
      accountId: 'z01',
    });
    expect(routeSelection('#/prj00000001/station/a1-e5036b5f')).toEqual({
      kind: 'station',
      project: PROJECT,
      accountId: 'a1-e5036b5f',
    });
    expect(routeSelection('#/prj00000001/station/tony')).toEqual({
      kind: 'station',
      project: PROJECT,
      accountId: 'tony',
    });
  });

  test('a station id that could escape its own segment is not a route', () => {
    for (const bad of [
      '#/prj00000001/station',
      '#/prj00000001/station/',
      '#/prj00000001/station/a/b',
      '#/prj00000001/station/../agent/1',
      '#/prj00000001/station/a b',
      '#/prj00000001/station/a.b',
      '#/prj00000001/Station/z01',
      `#/prj00000001/station/${'z'.repeat(65)}`,
    ])
      expect(routeSelection(bad)).toEqual({ kind: 'none' });
  });

  test('an id-shaped first segment is a project, not a miss', () => {
    expect(routeSelection('#/connectorsx')).toEqual({
      kind: 'agents',
      project: 'connectorsx',
    });
  });

  test('the documentation page is its own path too', () => {
    expect(routeSelection('#/docs/setup')).toEqual({ kind: 'docs' });
  });

  test('the settings page is its own path too', () => {
    expect(routeSelection('#/settings')).toEqual({ kind: 'settings' });
  });

  test('the connectors page is its own path too', () => {
    expect(routeSelection('#/prj00000001/connectors')).toEqual({ kind: 'connectors', project: PROJECT });
    expect(routeSelection('/prj00000001/connectors')).toEqual({ kind: 'connectors', project: PROJECT });
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
      '#/agent/1',
      '#/agent/id00000000',
      '#/agent/id0000000012',
      '#/agent/id00000000.',
      '#/agent/id00000000+',
      '#/agent/ id00000001',
      '#/agent/id00000001 ',
      '#/agent/id000000001/2',
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
      '#/connectors/1',
      '#/Connectors',
      '#/connectors/',
      '#/connector',
    ])
      expect(routeSelection(bad)).toEqual({ kind: 'none' });
  });

  test('an id-shaped first segment is a project, not a miss', () => {
    expect(routeSelection('#/connectorsx')).toEqual({
      kind: 'agents',
      project: 'connectorsx',
    });
  });
});

describe('routeHash', () => {
  test('a selected agent is reflected as its own url', () => {
    expect(routeHash({ kind: 'agent', project: PROJECT, id: 'id000000001' })).toBe(
      '#/prj00000001/agent/id000000001',
    );
    expect(routeHash({ kind: 'agent', project: PROJECT, id: 'aB3-_xYz9Qw' })).toBe(
      '#/prj00000001/agent/aB3-_xYz9Qw',
    );
  });

  test('a selected station is reflected as its own url', () => {
    expect(routeHash({ kind: 'station', project: PROJECT, accountId: 'z01' })).toBe('#/prj00000001/station/z01');
  });

  test('the create pane, the start page and the no-selection state have stable urls', () => {
    expect(routeHash({ kind: 'docs' })).toBe('#/docs/setup');
    expect(routeHash({ kind: 'settings' })).toBe('#/settings');
    expect(routeHash({ kind: 'none' })).toBe('#/');
  });

  test('the connectors page serializes to its own url, not the fallback', () => {
    expect(routeHash({ kind: 'connectors', project: PROJECT })).toBe('#/prj00000001/connectors');
  });

  test('every hash it writes parses back to the same selection', () => {
    for (const selection of [
      { kind: 'agent', project: PROJECT, id: 'id000000007' } as const,
      { kind: 'station', project: PROJECT, accountId: 'a1-e5036b5f' } as const,
      { kind: 'connectors', project: PROJECT } as const,
      { kind: 'collections', project: PROJECT } as const,
      { kind: 'members', project: PROJECT } as const,
      { kind: 'project', project: PROJECT } as const,
      { kind: 'agents', project: PROJECT } as const,
      { kind: 'docs' } as const,
      { kind: 'settings' } as const,
      { kind: 'authorize' } as const,
      { kind: 'none' } as const,
    ])
      expect(routeSelection(routeHash(selection))).toEqual(selection);
  });
});
