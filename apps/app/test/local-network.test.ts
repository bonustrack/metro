import { describe, expect, test } from 'bun:test';
import { firstPermission, LOCAL_NETWORK_BLOCKED, LOCAL_NETWORK_PERMISSIONS } from '../src/lib/local-network-state.ts';

describe('the browser permission that lets metro.box reach a box on the tailnet', () => {
  test('the first permission name the browser knows answers, a name it does not know is skipped', async () => {
    const asked: string[] = [];
    const browser = (known: Record<string, string>) => ({
      query: ({ name }: { name: string }) => {
        asked.push(name);
        const state = known[name];
        return state === undefined ? Promise.reject(new TypeError(`${name} is not a valid permission name`)) : Promise.resolve({ state });
      },
    });
    expect(await firstPermission(browser({ 'local-network-access': 'denied' }))).toEqual({ state: 'denied' });
    expect(asked).toEqual([...LOCAL_NETWORK_PERMISSIONS]);
    expect(await firstPermission(browser({ 'local-network': 'granted', 'local-network-access': 'denied' }))).toEqual({ state: 'granted' });
    expect(await firstPermission(browser({}))).toBeNull();
    expect(await firstPermission(undefined)).toBeNull();
  });

  test('the offline page says what to change, in plain words', () => {
    expect(LOCAL_NETWORK_BLOCKED).toContain('allow Local network access');
    expect(LOCAL_NETWORK_BLOCKED).toContain('a Tailscale address counts as one');
  });
});
