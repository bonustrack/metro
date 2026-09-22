import { describe, expect, test } from 'bun:test';
import { namehash } from 'viem';
import { profileOf, profileView, senderFields, type Reader } from '../src/sender.ts';
import { reverseNodeOf } from '../src/profile.ts';

const ALICE = '0xA94c000000000000000000000000000000001767';
const NODE = namehash('alice-stage.stage.base.eth');
const ZERO = '0x0000000000000000000000000000000000000000';

interface Read {
  functionName: string;
  args: readonly unknown[];
}

function fakeChain(primary: string, records: Record<string, string>, forward = ALICE): Reader {
  const readContract = ({ functionName, args }: Read): Promise<unknown> => {
    if (functionName === 'resolver') return Promise.resolve(ZERO);
    if (functionName === 'name') return Promise.resolve(args[0] === reverseNodeOf(ALICE) ? primary : '');
    if (functionName === 'addr') return Promise.resolve(args[0] === NODE ? forward : ZERO);
    if (functionName === 'text') return Promise.resolve(args[0] === NODE ? (records[String(args[1])] ?? '') : '');
    return Promise.reject(new Error(`unexpected read ${functionName}`));
  };
  return { readContract } as unknown as Reader;
}

const noProxy: typeof fetch = () => Promise.reject(new Error('the proxy must not be asked'));
const proxyNaming = (name: string | null): typeof fetch => (() => Promise.resolve(new Response(JSON.stringify({ name }), { headers: { 'content-type': 'application/json' } }))) as typeof fetch;

describe('an XMTP sender profile', () => {
  test('is the primary Basename with its name, description and avatar records', async () => {
    const chain = fakeChain('alice-stage.stage.base.eth', { name: ' Alice ', description: 'Onboarding on Stage', avatar: 'ipfs://bafy1' });
    const profile = await profileOf(ALICE, chain, noProxy);
    expect(profile).toEqual({ address: ALICE, name: 'alice-stage.stage.base.eth', displayName: 'Alice', about: 'Onboarding on Stage', avatar: 'ipfs://bafy1' });
    expect(senderFields(profile)).toEqual({ from_name: 'alice-stage.stage.base.eth', from_display_name: 'Alice' });
    expect(profileView('8f3e', profile)).toEqual({ id: '8f3e', address: ALICE, name: 'alice-stage.stage.base.eth', display_name: 'Alice', about: 'Onboarding on Stage', avatar: 'ipfs://bafy1' });
  });

  test('falls back to the name stage issued when there is no reverse record, and to the bare address when there is no name', async () => {
    const chain = fakeChain('', { name: 'Alice', avatar: 'not a url' });
    expect(await profileOf(ALICE, chain, proxyNaming('alice-stage.stage.base.eth'))).toEqual({ address: ALICE, name: 'alice-stage.stage.base.eth', displayName: 'Alice', about: null, avatar: null });
    const bare = await profileOf(ALICE, chain, proxyNaming(null));
    expect(bare).toEqual({ address: ALICE, name: null, displayName: null, about: null, avatar: null });
    expect(senderFields(bare)).toEqual({ from_name: ALICE });
    expect(senderFields(null)).toEqual({});
    expect(profileView('8f3e', null)).toEqual({ id: '8f3e' });
  });

  test('a read the RPC refuses fails the lookup rather than answering a half profile', async () => {
    const chain = fakeChain('alice-stage.stage.base.eth', { name: 'Alice' });
    const flaky = {
      readContract: (read: Read) => (read.functionName === 'text' && read.args[1] === 'name' ? Promise.reject(new Error('over rate limit')) : chain.readContract(read as never)),
    } as unknown as Reader;
    await expect(profileOf(ALICE, flaky, noProxy)).rejects.toThrow('over rate limit');
  });

  test('a name whose forward record points elsewhere is not believed', async () => {
    const chain = fakeChain('alice-stage.stage.base.eth', { name: 'Mallory' }, '0x0000000000000000000000000000000000000bad');
    expect((await profileOf(ALICE, chain, noProxy)).name).toBeNull();
  });
});
