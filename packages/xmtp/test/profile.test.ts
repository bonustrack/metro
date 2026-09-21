import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, namehash, parseAbi, type Hex } from 'viem';
import { BASENAME_L2_RESOLVER, BASENAME_REVERSE_REGISTRAR, encodeTextRecords, ensurePrimaryName, pinAvatar, reverseNodeOf, writeProfile } from '../src/profile.ts';
import type { SmartAccount } from '../src/smart.ts';

const RESOLVER = parseAbi(['function setText(bytes32 node, string key, string value)', 'function multicall(bytes[] data) returns (bytes[])']);
const REVERSE = parseAbi(['function setName(string name) returns (bytes32)']);

interface Sent {
  to: Hex;
  data: Hex;
}

function fakeSmart(sent: Sent[], resolver: Hex = '0x0000000000000000000000000000000000000000', primary = ''): SmartAccount {
  return {
    address: '0x1111111111111111111111111111111111111111',
    publicClient: {
      readContract: ({ functionName }: { functionName: string }) => Promise.resolve(functionName === 'name' ? primary : resolver),
      waitForTransactionReceipt: () => Promise.resolve({ status: 'success' }),
      getCode: () => Promise.resolve('0x60'),
    } as unknown as SmartAccount['publicClient'],
    client: () =>
      ({
        sendTransaction: (tx: Sent) => {
          sent.push(tx);
          return Promise.resolve('0xhash');
        },
      }) as unknown as ReturnType<SmartAccount['client']>,
    signMessage: () => Promise.resolve('0xsig'),
    deployed: () => Promise.resolve(true),
  };
}

describe('the XMTP profile on Base', () => {
  test('the records are one multicall of setText on the name node, in the ENS keys stage reads', () => {
    const data = encodeTextRecords('lisa-mci.stage.base.eth', { name: 'Lisa', description: 'invoices', avatar: 'ipfs://cid' });
    const outer = decodeFunctionData({ abi: RESOLVER, data });
    expect(outer.functionName).toBe('multicall');
    const calls = (outer.args[0] as Hex[]).map((inner) => decodeFunctionData({ abi: RESOLVER, data: inner }));
    const node = namehash('lisa-mci.stage.base.eth');
    expect(calls.map((c) => c.args)).toEqual([
      [node, 'name', 'Lisa'],
      [node, 'description', 'invoices'],
      [node, 'avatar', 'ipfs://cid'],
    ]);
  });

  test('the avatar is pinned first, then the sponsored transaction goes to the name resolver, and the caches are cleared', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xmtp-profile-'));
    const picture = join(dir, 'l.png');
    writeFileSync(picture, Buffer.from([1, 2, 3, 4]));
    const urls: string[] = [];
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      if (String(input).includes('pineapple')) {
        const file = (init?.body as FormData).get('file') as Blob;
        expect(file.size).toBe(4);
        return Promise.resolve(new Response(JSON.stringify({ result: { cid: 'bafy123' } }), { status: 200 }));
      }
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as typeof fetch;
    const sent: Sent[] = [];
    const hash = await writeProfile(fakeSmart(sent), 'lisa-mci.stage.base.eth', { bio: 'invoices', avatar: { path: picture, mime: 'image/png', name: 'l.png' } }, fetchImpl);
    expect(hash).toBe('0xhash');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(BASENAME_L2_RESOLVER);
    const calls = (decodeFunctionData({ abi: RESOLVER, data: sent[0]?.data ?? '0x' }).args[0] as Hex[]).map((inner) => decodeFunctionData({ abi: RESOLVER, data: inner }).args);
    expect(calls.map((c) => [c[1], c[2]])).toEqual([['description', 'invoices'], ['avatar', 'ipfs://bafy123']]);
    expect(urls).toEqual(['https://pineapple.fyi/upload', 'https://stamp.fyi/clear/address/0x1111111111111111111111111111111111111111', 'https://stamp.fyi/clear/avatar/eth:0x1111111111111111111111111111111111111111']);
    const custom: Sent[] = [];
    await writeProfile(fakeSmart(custom, '0x2222222222222222222222222222222222222222'), 'lisa-mci.stage.base.eth', { name: 'Lisa' }, fetchImpl);
    expect(custom[0]?.to).toBe('0x2222222222222222222222222222222222222222');
  });

  test('a refused upload and a non-image are errors before any transaction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xmtp-profile-'));
    const picture = join(dir, 'x.png');
    writeFileSync(picture, Buffer.from([1]));
    const refusing = ((_input: RequestInfo | URL) => Promise.resolve(new Response(JSON.stringify({ error: { message: 'too big' } }), { status: 200 }))) as unknown as typeof fetch;
    await expect(pinAvatar({ path: picture, mime: 'image/png', name: 'x' }, refusing)).rejects.toThrow('too big');
    await expect(pinAvatar({ path: picture, mime: 'text/plain', name: 'x' }, refusing)).rejects.toThrow('must be an image');
  });

  test('the primary name is set on the Base reverse registrar once, and left alone when it already matches', async () => {
    expect(reverseNodeOf('0x1111111111111111111111111111111111111111')).toMatch(/^0x[0-9a-f]{64}$/);
    expect(reverseNodeOf('0x1111111111111111111111111111111111111111')).toBe(reverseNodeOf('0x1111111111111111111111111111111111111111'.toUpperCase().replace('0X', '0x')));
    const sent: Sent[] = [];
    expect(await ensurePrimaryName(fakeSmart(sent), 'lisa-mci.stage.base.eth')).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(BASENAME_REVERSE_REGISTRAR);
    expect(decodeFunctionData({ abi: REVERSE, data: sent[0]?.data ?? '0x' }).args).toEqual(['lisa-mci.stage.base.eth']);
    const held: Sent[] = [];
    expect(await ensurePrimaryName(fakeSmart(held, '0x0000000000000000000000000000000000000000', 'lisa-mci.stage.base.eth'), 'lisa-mci.stage.base.eth')).toBe(true);
    expect(held).toEqual([]);
  });
});
