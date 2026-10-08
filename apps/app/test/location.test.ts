import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));

const check = `
import assert from 'node:assert/strict';
import { mock } from 'bun:test';

const platform = process.env.TEST_PLATFORM;
const address = new URL('https://metro.test/#/login?invited=1');
const pending = [];
const router = {
  push: (path) => pending.push(path),
  replace: (path) => pending.push(path),
};
if (platform === 'web') {
  globalThis.window = {
    location: address,
    history: { replaceState: (_state, _title, url) => { address.href = new URL(url, address).href; } },
  };
}
mock.module('react-native', () => ({ Platform: { OS: platform } }));
mock.module('expo-router', () => ({ router, usePathname: () => '/', useGlobalSearchParams: () => ({}) }));
mock.module('expo/fetch', () => ({ fetch: globalThis.fetch }));

const { prepareLocation, noteRouteHash } = await import('./src/lib/location.js');
const { useSelection } = await import('./src/lib/route-hash.js');
const { location, configurePlatform, memoryKeyValue } = await import('@metro-labs/client/platform');
const { atLanding, atLogin, atWaitlist, readOutcome, clearOutcome, goToLogin } = await import('@metro-labs/client/auth/login-route');
const { takeInvitationFromUrl, pendingInvitation } = await import('@metro-labs/client/auth/invitation');
const storage = memoryKeyValue();
configurePlatform({ kv: storage, tabKv: storage });
prepareLocation();
assert.equal(location().hash(), platform === 'web' ? '#/login?invited=1' : '#/');

if (platform === 'web') {
  address.hash = '';
  address.search = '?invitation_token=synthetic_invitation';
  prepareLocation();
  useSelection();
  assert.equal(location().hash(), '');
  takeInvitationFromUrl();
  assert.equal(location().hash(), '#/login');
  assert.equal(pendingInvitation(), 'synthetic_invitation');
  assert.equal(address.search, '');
}

noteRouteHash('#/');
address.hash = '#/';
router.push('/login');
noteRouteHash('#/login');
assert.equal(address.hash, '#/');
assert.equal(atLanding(), false);
assert.equal(atLogin(), true);
goToLogin();
assert.equal(location().hash(), '#/login');
address.hash = pending.at(-1);

for (const hash of ['#/', '#/login', '#/', '#/waitlist', '#/', '#/login']) {
  noteRouteHash(hash);
  assert.equal(location().hash(), hash);
  assert.equal(atLanding(), hash === '#/');
  assert.equal(atWaitlist(), hash === '#/waitlist');
  address.hash = hash;
}

for (const hash of ['#/login', '#/waitlist']) {
  address.hash = hash;
  prepareLocation();
  noteRouteHash(hash);
  assert.equal(atLogin(), true);
  assert.equal(atWaitlist(), hash === '#/waitlist');
}

noteRouteHash('#/login?refused=cancelled&redirect=%2Fteam%2Fagent%2Fserver');
assert.equal(readOutcome().refused, 'cancelled');
clearOutcome();
assert.equal(location().hash(), '#/login?redirect=%2Fteam%2Fagent%2Fserver');
assert.equal(pending.at(-1), '/login?redirect=%2Fteam%2Fagent%2Fserver');

noteRouteHash('#/team/agent/server');
goToLogin();
assert.equal(location().hash(), '#/login?redirect=%2Fteam%2Fagent%2Fserver');
assert.equal(pending.at(-1), '/login?redirect=%2Fteam%2Fagent%2Fserver');

location().push('#/waitlist');
assert.equal(atWaitlist(), true);
assert.equal(pending.at(-1), '/waitlist');
location().replace('#/');
assert.equal(atLanding(), true);
assert.equal(pending.at(-1), '/');
`;

test.each(['web', 'android'])('%s auth routes follow the rendered route before history catches up', (platform) => {
  const result = Bun.spawnSync([process.execPath, '--eval', check], {
    cwd,
    env: { ...process.env, TEST_PLATFORM: platform },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  });
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
});
