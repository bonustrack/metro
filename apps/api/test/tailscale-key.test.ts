import { describe, expect, test } from 'bun:test';
import { BOX_TAG, KEY_TTL_SECONDS, mintAuthKey } from '../src/aws/tailscale-key.ts';

const CLIENT = { id: 'kCLIENT1CNTRL', secret: 'tskey-client-kCLIENT1CNTRL-abcdefghijklmnop' };

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function fakeTailscale(answers: [number, unknown][]): { fetchFn: (url: string, init: RequestInit) => Promise<Response>; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchFn = (url: string, init: RequestInit): Promise<Response> => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    const [status, body] = answers[seen.length - 1] ?? [500, { message: 'unexpected call' }];
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { fetchFn, seen };
}

describe('a one-time Tailscale key per launch', () => {
  test('the OAuth client is traded for a token, which makes a single-use, preauthorized, tagged key that lives one hour', async () => {
    const { fetchFn, seen } = fakeTailscale([
      [200, { access_token: 'tok-1', token_type: 'Bearer', expires_in: 3600 }],
      [200, { id: 'k1', key: 'tskey-auth-kONETIME1CNTRL-abcdefghijklmnop' }],
    ]);
    expect(await mintAuthKey(CLIENT, 'metro-abc123', fetchFn)).toBe('tskey-auth-kONETIME1CNTRL-abcdefghijklmnop');
    expect(seen.map((s) => s.url)).toEqual(['https://api.tailscale.com/api/v2/oauth/token', 'https://api.tailscale.com/api/v2/tailnet/-/keys']);
    const form = new URLSearchParams(seen[0]?.body);
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', client_id: CLIENT.id, client_secret: CLIENT.secret });
    expect(seen[1]?.headers.authorization).toBe('Bearer tok-1');
    expect(JSON.parse(seen[1]?.body ?? '{}')).toEqual({
      capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: [BOX_TAG] } } },
      expirySeconds: KEY_TTL_SECONDS,
      description: 'metro launch metro-abc123',
    });
    expect(KEY_TTL_SECONDS).toBe(3600);
    expect(BOX_TAG).toBe('tag:metro-box');
  });

  test('a refusal names the step and Tailscale\'s own reason, never the secret', async () => {
    const { fetchFn } = fakeTailscale([[401, { message: 'invalid client credentials' }]]);
    const err = await mintAuthKey(CLIENT, 'metro-abc123', fetchFn).catch((e: unknown) => e);
    expect(String(err)).toContain('Tailscale refused the OAuth client (HTTP 401: invalid client credentials)');
    expect(String(err)).not.toContain(CLIENT.secret);
    const tags = fakeTailscale([
      [200, { access_token: 'tok-1' }],
      [400, { message: 'requested tags [tag:metro-box] are invalid or not permitted' }],
    ]);
    await expect(mintAuthKey(CLIENT, 'metro-abc123', tags.fetchFn)).rejects.toThrow('not permitted');
  });

  test('an answer without a usable key is refused rather than written into a box', async () => {
    for (const answer of [{}, { key: 'tskey-client-kX-abcdefghijklmnop' }, { key: "tskey-auth-x'; reboot" }]) {
      const { fetchFn } = fakeTailscale([[200, { access_token: 'tok-1' }], [200, answer]]);
      await expect(mintAuthKey(CLIENT, 'metro-abc123', fetchFn)).rejects.toThrow('without an auth key');
    }
    const { fetchFn } = fakeTailscale([[200, { token_type: 'Bearer' }]]);
    await expect(mintAuthKey(CLIENT, 'metro-abc123', fetchFn)).rejects.toThrow('without a token');
  });
});
