import { describe, expect, test } from 'bun:test';
import { toModelSettings, type ModelSync } from '@metro-labs/client/api/model';
import { linkWords, shouldEnroll, type Attempt, type EnrollCheck } from '../src/lib/auto-enroll.ts';

const syncOf = (sync: unknown): ModelSync | null => toModelSettings({ route: '', connections: [], sync }).sync;
const unlinked = syncOf({ enrolled: false, at: null, error: null });
const linked = syncOf({ enrolled: true, at: '2026-10-17T08:00:00.000Z', error: null });
const check = (over: Partial<EnrollCheck>): EnrollCheck => ({ admin: true, sync: unlinked, readFailed: false, attempt: undefined, ...over });

describe('linking an agent to its organization from the page', () => {
  test('an organization admin links a box that explicitly answers it is not enrolled', () => {
    expect(shouldEnroll(check({}))).toBe(true);
  });

  test('never when the box is enrolled, since a new enrollment replaces its identity', () => {
    expect(shouldEnroll(check({ sync: linked }))).toBe(false);
  });

  test('never on an unknown answer: no sync, an old daemon, a sync without a yes or no, or no reading yet', () => {
    expect(shouldEnroll(check({ sync: null }))).toBe(false);
    expect(shouldEnroll(check({ sync: undefined }))).toBe(false);
    expect(syncOf({ at: null })).toBeNull();
    expect(syncOf({ enrolled: 'false' })).toBeNull();
    expect(shouldEnroll(check({ sync: syncOf({ error: 'down' }) }))).toBe(false);
    expect(shouldEnroll(check({ sync: toModelSettings({ route: '', connections: [] }).sync }))).toBe(false);
  });

  test('never when the last reading of the box failed', () => {
    expect(shouldEnroll(check({ readFailed: true }))).toBe(false);
  });

  test('a member who is not an admin does nothing', () => {
    expect(shouldEnroll(check({ admin: false }))).toBe(false);
  });

  test('one try per box: not while one runs, not after one finished or failed', () => {
    const tried: Attempt[] = [{ state: 'running' }, { state: 'done' }, { state: 'failed', error: 'The agent is not running. Start it, then enroll.' }];
    expect(tried.map((attempt) => shouldEnroll(check({ attempt })))).toEqual([false, false, false]);
  });
});

describe('what the page says about the link', () => {
  test('nothing once the box is enrolled or when it cannot tell', () => {
    expect(linkWords(linked, undefined, true)).toBeNull();
    expect(linkWords(null, { state: 'failed', error: 'x' }, true)).toBeNull();
  });

  test('an admin sees it linking, then the reason and a retry only when it failed', () => {
    expect(linkWords(unlinked, undefined, true)).toMatchObject({ line: 'Linking this agent to the organization…', error: null, danger: false });
    expect(linkWords(unlinked, { state: 'running' }, true)?.danger).toBe(false);
    const failed = linkWords(unlinked, { state: 'failed', error: 'Update this agent to the latest Metro, then try again.' }, true);
    expect(failed).toMatchObject({ line: 'This agent could not link to the organization: Update this agent to the latest Metro, then try again.', error: 'Update this agent to the latest Metro, then try again.', danger: true });
  });

  test('a member is told an admin links it by opening its page, and never to enroll it on the Server page', () => {
    const words = linkWords(unlinked, undefined, false);
    expect(words?.line).toContain('an admin of the organization opens its page');
    expect(JSON.stringify(words)).not.toContain('Server page');
  });
});
