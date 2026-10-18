import { describe, expect, test } from 'bun:test';
import { routeNames, routeOf, routeText, withoutConnection } from '../src/model-route.ts';

const step = (connection: string, model = 'm'): { connection: string; model: string } => ({ connection, model });

describe('a stored route', () => {
  test('reads its helpers and effort, and drops a bad part instead of the route', () => {
    const text = JSON.stringify({ primary: step('conn0000001'), fallbacks: [], helpers: { primary: step('conn0000002'), fallbacks: [step('conn0000003')] }, effort: { main: 'medium', helpers: 'asked' } });
    const route = routeOf(text);
    expect(route).toEqual({ primary: step('conn0000001'), fallbacks: [], helpers: { primary: step('conn0000002'), fallbacks: [step('conn0000003')] }, effort: { main: 'medium', helpers: 'asked' } });
    expect(route === null ? [] : routeNames(route)).toEqual(['conn0000001', 'conn0000002', 'conn0000003']);
    const broken = routeOf(JSON.stringify({ primary: step('conn0000001'), fallbacks: [], helpers: { primary: 'x' }, effort: { main: 'extreme', helpers: 'high', other: 'low' } }));
    expect(broken).toEqual({ primary: step('conn0000001'), fallbacks: [], effort: { helpers: 'high' } });
    expect(routeText({ primary: step('conn0000001'), fallbacks: [], effort: {} })).toBe(JSON.stringify({ primary: step('conn0000001'), fallbacks: [] }));
  });

  test('a removed connection leaves the helpers too, and the route goes only with its main models', () => {
    const route = { primary: step('conn0000001'), fallbacks: [], helpers: { primary: step('conn0000002'), fallbacks: [step('conn0000001')] }, effort: { main: 'high' as const } };
    expect(withoutConnection(route, 'conn0000002')).toEqual({ primary: step('conn0000001'), fallbacks: [], helpers: { primary: step('conn0000001'), fallbacks: [] }, effort: { main: 'high' } });
    expect(withoutConnection({ ...route, helpers: { primary: step('conn0000002'), fallbacks: [] } }, 'conn0000002')).toEqual({ primary: step('conn0000001'), fallbacks: [], effort: { main: 'high' } });
    expect(withoutConnection(route, 'conn0000001')).toBeNull();
  });
});
