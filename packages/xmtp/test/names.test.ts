import { describe, expect, test } from 'bun:test';
import { checkLabel, claimMessage, claimName, nameOf, parseLabel, stageNameOf } from '../src/names.ts';

interface Seen {
  url: string;
  body?: unknown;
}

function fakeProxy(answers: Record<string, unknown>, seen: Seen[]): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const path = url.slice(url.indexOf('/names/') + 7).split('?')[0] ?? '';
    const answer = answers[path];
    const status = typeof answer === 'object' && answer !== null && 'error' in answer ? 400 : 200;
    return Promise.resolve(new Response(JSON.stringify(answer ?? {}), { status, headers: { 'content-type': 'application/json' } }));
  }) as typeof fetch;
}

describe('stage names', () => {
  test('labels follow the Worker rules, and the claim message is the one the Worker verifies', () => {
    expect(parseLabel('  Lisa-MCI ')).toBe('lisa-mci');
    expect(() => parseLabel('lisa')).toThrow('at least 6');
    expect(() => parseLabel('a'.repeat(33))).toThrow('at most 32');
    expect(() => parseLabel('lisa--mci')).toThrow('single inner hyphens');
    expect(() => parseLabel('-lisamci')).toThrow('single inner hyphens');
    expect(() => parseLabel('lisa_mci')).toThrow('single inner hyphens');
    expect(stageNameOf('lisa-mci')).toBe('lisa-mci.stage.base.eth');
    expect(claimMessage('lisa-mci', '0xABCDEF', 1700000000000)).toBe('Claim lisa-mci.stage.base.eth for 0xabcdef at 1700000000000');
  });

  test('status, check and claim go to the Worker with the signed message, and refusals are named', async () => {
    const seen: Seen[] = [];
    const proxy = fakeProxy({ status: { name: null }, check: { valid: true, available: true }, claim: { name: 'lisa-mci.stage.base.eth' } }, seen);
    expect(await nameOf('0xabc', proxy)).toBeNull();
    const signed: string[] = [];
    const name = await claimName('lisa-mci', '0xAbC', (message) => {
      signed.push(message);
      return Promise.resolve('0xsig');
    }, proxy, 1700000000000);
    expect(name).toBe('lisa-mci.stage.base.eth');
    expect(signed).toEqual(['Claim lisa-mci.stage.base.eth for 0xabc at 1700000000000']);
    expect(seen.map((s) => s.url.slice(s.url.indexOf('/names/')))).toEqual(['/names/status?address=0xabc', '/names/check?label=lisa-mci', '/names/claim']);
    expect(seen[2]?.body).toEqual({ label: 'lisa-mci', address: '0xAbC', issuedAt: 1700000000000, signature: '0xsig' });
    const taken = fakeProxy({ check: { valid: true, available: false } }, []);
    await expect(checkLabel('lisa-mci', taken)).rejects.toThrow('already taken');
    const invalid = fakeProxy({ check: { valid: false, reason: 'reserved' } }, []);
    await expect(checkLabel('lisa-mci', invalid)).rejects.toThrow('reserved');
    const refused = fakeProxy({ check: { valid: true, available: true }, claim: { error: 'invalid signature' } }, []);
    await expect(claimName('lisa-mci', '0xabc', () => Promise.resolve('0x'), refused)).rejects.toThrow('invalid signature');
    const held = fakeProxy({ status: { name: 'lisa-mci.stage.base.eth' } }, []);
    expect(await nameOf('0xabc', held)).toBe('lisa-mci.stage.base.eth');
  });
});
