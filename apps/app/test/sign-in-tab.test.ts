import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const check = `
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
const platform = process.env.TEST_PLATFORM;
const calls = [];
const external = [];
mock.module('react-native', () => ({ Platform: { OS: platform } }));
mock.module('./src/lib/open.js', () => ({ openExternal: (url) => external.push(url) }));
mock.module('./src/lib/queries.js', () => ({ queryError: () => '', refresh: () => undefined }));
mock.module('./src/lib/model-queries.js', () => ({ afterModelChange: () => undefined }));
const { inNewTab } = await import('./src/components/sign-in-tab.js');
const target = 'https://provider.example.com/authorize?resource=public';
if (platform !== 'web') {
  await inNewTab(async () => target, (url) => url, () => assert.fail());
  assert.deepEqual(external, [target]);
} else {
  const tab = {
    opener: { privileged: true },
    location: { assign: (url) => { assert.equal(tab.opener, null); calls.push(url); } },
    close: () => calls.push('closed'),
  };
  globalThis.window = { open: (...args) => { assert.deepEqual(args, ['', '_blank']); calls.push('opened'); return tab; } };
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const pending = inNewTab(async () => { assert.equal(tab.opener, null); await waiting; return target; }, (url) => url, () => assert.fail());
  assert.deepEqual(calls, ['opened']);
  release();
  assert.equal(await pending, target);
  assert.deepEqual(calls, ['opened', target]);
  calls.length = 0;
  await assert.rejects(inNewTab(async () => { throw new Error('refused'); }, (url) => url, () => assert.fail()), /refused/);
  assert.deepEqual(calls, ['opened', 'closed']);
  calls.length = 0;
  await inNewTab(async () => null, (url) => url, () => assert.fail());
  assert.deepEqual(calls, ['opened', 'closed']);
  globalThis.window.open = () => null;
  const blocked = [];
  await inNewTab(async () => target, (url) => url, (url) => blocked.push(url));
  assert.deepEqual(blocked, [target]);
}
`;

test.each(['web', 'android'])('%s sign-in keeps synchronous opening and never exposes an admin opener', (platform) => {
  const result = Bun.spawnSync([process.execPath, '--eval', check], { cwd, env: { ...process.env, TEST_PLATFORM: platform }, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
});
