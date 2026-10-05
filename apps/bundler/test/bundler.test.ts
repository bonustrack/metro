import { afterEach, describe, expect, test } from 'bun:test';
import { branchFromPath, branchPath, channelKey } from '../src/branchChannel.ts';
import { handleBundler, isBrowserRequest, manifestUrl } from '../src/bundler.ts';

const HOST = 'https://bundler.metro.box';
const LAUNCHER = '<!doctype html><title>launcher</title>';
const EXPO_CLIENT = { 'expo-platform': 'android', 'expo-runtime-version': 'abc123', accept: 'multipart/mixed' };
const BROWSER = { accept: 'text/html,application/xhtml+xml' };

const realFetch = globalThis.fetch;
let fetched: string[] = [];

function stubFetch(): void {
  fetched = [];
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL): Promise<Response> => {
      fetched.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(new Response('manifest'));
    },
    { preconnect: realFetch.preconnect },
  );
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function channelsFetched(): (string | null)[] {
  return fetched.map((url) => new URL(url).searchParams.get('channel-name'));
}

async function get(path: string, headers: Record<string, string>): Promise<Response> {
  return handleBundler(new Request(`${HOST}${path}`, { headers }), LAUNCHER);
}

describe('channelKey', () => {
  test('keeps plain names and escapes every other byte', () => {
    expect(channelKey('main')).toBe('main');
    expect(channelKey('release-0.1.4')).toBe('release-0.1.4');
    expect(channelKey('feat/metro-app')).toBe('feat_2fmetro-app');
    expect(channelKey('fix_menu')).toBe('fix_5fmenu');
    expect(channelKey('fix/café')).toBe('fix_2fcaf_c3_a9');
  });

  test('never maps two branch names to one channel', () => {
    const branches = ['feat/foo', 'feat-foo', 'feat_foo', 'feat_2ffoo', 'feat/foo/bar', 'Feat/foo', 'feat/fóo'];
    expect(new Set(branches.map(channelKey)).size).toBe(branches.length);
  });
});

describe('branchFromPath', () => {
  test('decodes percent escapes once', () => {
    expect(branchFromPath('/feat/metro-app')).toBe('feat/metro-app');
    expect(branchFromPath('/feat%2Fmetro-app')).toBe('feat/metro-app');
    expect(branchFromPath('/feat%252Fx')).toBe('feat%2Fx');
    expect(branchFromPath('/chore/v0.1.0-beta.2/')).toBe('chore/v0.1.0-beta.2');
  });

  test('refuses paths that are not branch names', () => {
    for (const path of ['/', '/feat//foo', '/.well-known/acme-challenge/x', '/feat/.hidden', '/feat%E0%A4%A']) {
      expect(branchFromPath(path)).toBeNull();
    }
  });

  test('round-trips through branchPath', () => {
    for (const branch of ['main', 'feat/metro-app', 'fix/café menu', 'a%2Fb', 'x#y?z']) {
      expect(branchFromPath(branchPath(branch))).toBe(branch);
    }
  });
});

describe('handleBundler', () => {
  test('tells a browser from the dev client', () => {
    expect(isBrowserRequest(new Request(HOST, { headers: BROWSER }))).toBe(true);
    expect(isBrowserRequest(new Request(HOST, { headers: { ...BROWSER, 'expo-platform': 'android' } }))).toBe(false);
    expect(isBrowserRequest(new Request(HOST, { headers: { accept: 'multipart/mixed' } }))).toBe(false);
  });

  test('asks EAS for the client runtime and platform', () => {
    const url = new URL(manifestUrl('main', new Request(HOST, { headers: { 'expo-runtime-version': 'r1', 'expo-platform': 'ios' } })));
    expect(url.origin + url.pathname).toBe('https://u.expo.dev/51aa82e1-6457-4e12-a9c2-30def4397e20');
    expect(url.searchParams.get('channel-name')).toBe('main');
    expect(url.searchParams.get('runtime-version')).toBe('r1');
    expect(url.searchParams.get('platform')).toBe('ios');
    expect(new URL(manifestUrl('main', new Request(HOST))).searchParams.get('platform')).toBe('android');
  });

  test('sends a browser to the launcher for the same branch', async () => {
    for (const path of ['/feat/metro-app', '/feat%2Fmetro-app']) {
      const response = await get(path, BROWSER);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(
        `${HOST}/preview-launcher.html?u=${encodeURIComponent(`${HOST}/feat/metro-app`)}`,
      );
    }
    const bare = await get('/', BROWSER);
    expect(bare.headers.get('location')).toBe(`${HOST}/preview-launcher.html?u=${encodeURIComponent(`${HOST}/main`)}`);
  });

  test('serves the launcher page itself', async () => {
    const response = await get('/preview-launcher.html?u=x', BROWSER);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe(LAUNCHER);
  });

  test('loads the branch channel for the dev client, main on the bare domain', async () => {
    stubFetch();
    for (const path of ['/feat/metro-app', '/feat%2Fmetro-app', '/feat-metro-app', '/', '/main']) {
      await get(path, EXPO_CLIENT);
    }
    expect(channelsFetched()).toEqual(['feat_2fmetro-app', 'feat_2fmetro-app', 'feat-metro-app', 'main', 'main']);
  });

  test('preserves Expo request headers and the multipart response without caching it', async () => {
    const response = new Response('--boundary\r\nmanifest\r\n--boundary--', {
      headers: {
        'content-type': 'multipart/mixed; boundary=boundary',
        'cache-control': 'no-cache, private, max-age=10',
        'expo-protocol-version': '1',
        'expo-update-id': 'update-id',
      },
    });
    let forwarded: Headers | undefined;
    globalThis.fetch = Object.assign(
      (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        forwarded = new Headers(init?.headers);
        return Promise.resolve(response);
      },
      { preconnect: realFetch.preconnect },
    );
    const result = await get('/main', {
      ...EXPO_CLIENT,
      host: 'bundler.metro.box',
      'expo-protocol-version': '1',
      'expo-expect-signature': 'sig, keyid="main"',
      'expo-current-update-id': 'previous-id',
    });
    expect(forwarded?.get('host')).toBeNull();
    expect(forwarded?.get('expo-platform')).toBe('android');
    expect(forwarded?.get('expo-runtime-version')).toBe('abc123');
    expect(forwarded?.get('expo-protocol-version')).toBe('1');
    expect(forwarded?.get('expo-expect-signature')).toBe('sig, keyid="main"');
    expect(forwarded?.get('expo-current-update-id')).toBe('previous-id');
    expect(forwarded?.get('accept')).toBe('multipart/mixed');
    expect(result).toBe(response);
    expect(result.headers.get('cache-control')).toBe('no-cache, private, max-age=10');
    expect(result.headers.get('expo-update-id')).toBe('update-id');
    expect(await result.text()).toBe('--boundary\r\nmanifest\r\n--boundary--');
  });

  test('preserves no-update and error responses instead of falling back to another runtime', async () => {
    for (const status of [204, 404]) {
      const body = status === 204 ? null : 'No compatible update';
      const response = new Response(body, { status });
      globalThis.fetch = Object.assign(
        (): Promise<Response> => Promise.resolve(response),
        { preconnect: realFetch.preconnect },
      );
      const result = await get('/main', EXPO_CLIENT);
      expect(result).toBe(response);
      expect(result.status).toBe(status);
      expect(await result.text()).toBe(body ?? '');
    }
  });

  test('answers 404 without calling EAS for paths that are not branches', async () => {
    stubFetch();
    for (const path of ['/preview-launcher.html', '/favicon.ico', '/feat//foo', '/.well-known/x']) {
      expect((await get(path, EXPO_CLIENT)).status).toBe(404);
    }
    expect((await get('/favicon.svg', BROWSER)).status).toBe(404);
    expect(fetched).toEqual([]);
  });
});
