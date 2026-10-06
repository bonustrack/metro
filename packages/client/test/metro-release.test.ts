import { afterEach, expect, spyOn, test } from 'bun:test';
import { fetchMetroRelease, newestMetroRelease, releaseAvailability } from '../src/api/metro-release.js';
import { configurePlatform } from '../src/platform.js';

const NOW = 1_791_288_000_000;
const RELEASE = { latest: '0.1.0-beta.271', checkedAt: NOW };
const browserFetch = (url: string, init: RequestInit): Promise<Response> => fetch(url, init);
afterEach(() => { configurePlatform({ fetchNoRedirect: browserFetch }); });

test('newest release uses numeric ordering across all dist-tags, not the stale latest tag', () => {
  expect(newestMetroRelease({ latest: '0.1.0-beta.0', beta: '0.1.0-beta.271', other: '0.1.0-beta.99' })).toBe(RELEASE.latest);
  expect(newestMetroRelease({ latest: '0.1.0', beta: RELEASE.latest })).toBe('0.1.0');
  expect(newestMetroRelease({ latest: 'bad', beta: RELEASE.latest, other: 42 })).toBe(RELEASE.latest);
  for (const invalid of [null, [], '0.1.0', {}, { beta: 'invalid' }]) expect(() => newestMetroRelease(invalid)).toThrow();
});

test.each([
  ['0.1.0-beta.270', RELEASE, false, NOW, 'newer'],
  ['0.1.0-beta.271', RELEASE, false, NOW, 'current'],
  ['0.1.0-beta.272', RELEASE, false, NOW, 'current'],
  ['0.1.0-beta.271', RELEASE, true, NOW, 'unavailable'],
  ['0.1.0-beta.270', RELEASE, true, NOW, 'unavailable'],
  ['0.1.0-beta.270', undefined, false, NOW, 'checking'],
  ['0.1.0-beta.270', undefined, true, NOW, 'unavailable'],
  ['0.1.0-beta.271', RELEASE, false, NOW + 120_001, 'stale'],
  ['0.1.0-beta.271', RELEASE, false, NOW - 1, 'stale'],
  [null, RELEASE, false, NOW, 'unavailable'],
  ['invalid', RELEASE, false, NOW, 'unavailable'],
] as const)('availability %s never conceals a failed, stale or missing check', (version, release, failed, now, kind) => {
  expect(releaseAvailability(version, release, failed, now).kind).toBe(kind);
});

test('release request is public, uncached, redirect-safe and has no owner credentials or referrer', async () => {
  const seen: Request[] = [];
  const options: RequestInit[] = [];
  configurePlatform({ fetchNoRedirect: (url, init) => {
    options.push(init);
    seen.push(new Request(url, init));
    return Promise.resolve(Response.json({ 'dist-tags': { latest: '0.1.0-beta.0', beta: RELEASE.latest } }));
  } });
  const before = Date.now();
  const result = await fetchMetroRelease(new AbortController().signal);
  expect(result.latest).toBe(RELEASE.latest);
  expect(result.checkedAt).toBeGreaterThanOrEqual(before);
  expect(seen).toHaveLength(1);
  const request = seen[0];
  expect(request?.url).toBe('https://registry.npmjs.org/@stage-labs%2Fmetro');
  expect(request?.method).toBe('GET');
  expect(options[0]?.credentials).toBe('omit');
  expect(options[0]?.referrerPolicy).toBe('no-referrer');
  expect(request?.cache).toBe('no-store');
  expect(request?.redirect).toBe('error');
  expect([...request?.headers ?? []]).toEqual([['accept', 'application/vnd.npm.install-v1+json']]);
});

test.each([503, 302])('release HTTP refusal %s is not a successful current check', async (status) => {
  configurePlatform({ fetchNoRedirect: () => Promise.resolve(new Response('', { status })) });
  await expect(fetchMetroRelease(new AbortController().signal)).rejects.toThrow('Could not check');
});

test('invalid registry JSON cannot manufacture release availability', async () => {
  configurePlatform({ fetchNoRedirect: () => Promise.resolve(new Response('bad json')) });
  await expect(fetchMetroRelease(new AbortController().signal)).rejects.toThrow();
});

test('caller cancellation aborts the request and pre-cancelled calls send nothing', async () => {
  const seen: AbortSignal[] = [];
  configurePlatform({ fetchNoRedirect: (_url, init) => new Promise((_resolve, reject) => {
    const signal = init.signal;
    if (signal == null) throw new Error('Missing abort signal');
    seen.push(signal);
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }) });
  const controller = new AbortController();
  Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined });
  const pending = fetchMetroRelease(controller.signal).catch((error: unknown) => error);
  controller.abort();
  expect(await pending).toBeInstanceOf(Error);
  expect(seen[0]?.aborted).toBe(true);
  await expect(fetchMetroRelease(controller.signal)).rejects.toThrow('cancelled');
  expect(seen).toHaveLength(1);
});

test('one eight-second deadline aborts a hanging registry request', async () => {
  const timers: { run: () => void; ms: number | undefined }[] = [];
  const original = globalThis.setTimeout;
  const host: { setTimeout: (callback: () => void, ms?: number) => ReturnType<typeof setTimeout> } = globalThis;
  const timer = spyOn(host, 'setTimeout').mockImplementation((run, ms) => {
    timers.push({ run, ms });
    const handle = original(() => undefined, 2 ** 30); handle.unref(); return handle;
  });
  configurePlatform({ fetchNoRedirect: (_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('deadline')), { once: true });
  }) });
  try {
    const pending = fetchMetroRelease(new AbortController().signal).catch((error: unknown) => error);
    expect(timers.map((entry) => entry.ms)).toEqual([8_000]);
    timers[0]?.run();
    expect(await pending).toBeInstanceOf(Error);
  } finally { timer.mockRestore(); }
});
