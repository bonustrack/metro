import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { accounts, type Account } from '../src/accounts.ts';
import { handleCall } from '../src/actions.ts';
import { buildWalletContent } from '../src/wallet.ts';

const accountId = 'wallet-test';
const line = `metro://xmtp/${accountId}/group1`;
const request = {
  version: '1.0',
  chainId: '0x2105',
  from: '0x1111111111111111111111111111111111111111',
  calls: [{ to: '0x2222222222222222222222222222222222222222', value: '0x38d7ea4c68000', metadata: { description: 'Dinner', amount: 0.001 } }],
};

const json = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));

describe('wallet content', () => {
  test('a payment request is xmtp.org/walletSendCalls JSON with Stage fallback', () => {
    const { encoded, summary } = buildWalletContent({ type: 'walletSendCalls', content: request });
    expect(encoded.type).toEqual({ authorityId: 'xmtp.org', typeId: 'walletSendCalls', versionMajor: 1, versionMinor: 0 });
    expect(json(encoded.content)).toEqual(request);
    expect(summary).toBe('[Transaction request] Dinner');
  });

  test('receipts and signatures use their own content types', () => {
    const receipt = buildWalletContent({ type: 'transactionReference', content: { networkId: 8453, reference: '0xabc' } });
    expect(receipt.encoded.type.typeId).toBe('transactionReference');
    expect(receipt.summary).toBe('[Transaction] 0xabc');
    const sign = buildWalletContent(JSON.stringify({ type: 'signatureRequest', content: { id: 's1', kind: 'personal', message: 'hi' } }));
    expect(sign.encoded.type).toMatchObject({ authorityId: 'metro.box', typeId: 'signatureRequest' });
    expect(buildWalletContent({ type: 'signatureReference', content: { requestId: 'm1', signature: '0x1', signer: '0x2' } }).summary).toBe('[Signature] 0x1');
  });

  test.each([
    [{ type: 'deleteMessage', content: {} }, /wallet type must be one of walletSendCalls/],
    [{ type: 'toString', content: {} }, /wallet type must be one of/],
    [{ type: 'walletSendCalls', content: 'nope' }, /wallet content is not valid JSON/],
    [{ type: 'walletSendCalls', content: { version: '1.0' } }, /walletSendCalls content needs chainId, from, calls/],
  ])('refuses %j', (raw, message) => {
    expect(() => buildWalletContent(raw)).toThrow(message);
  });
});

describe('send with a wallet card', () => {
  let out: string[] = [];
  let sent: unknown[] = [];
  let restore = (): void => {};

  beforeEach(() => {
    out = [];
    sent = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    restore = () => spy.mockRestore();
    const group = {
      id: 'group1',
      sendText: async (text: string) => { sent.push(text); return 'text-msg-id'; },
      send: async (content: unknown) => { sent.push(content); return `card-${String(sent.length)}`; },
    };
    const client = { inboxId: 'self', conversations: { getConversationById: async () => group } };
    accounts.set(accountId, { cfg: { id: accountId }, client, inboxId: 'self' } as unknown as Account);
  });
  afterEach(() => {
    restore();
    accounts.delete(accountId);
  });

  const call = async (args: Record<string, unknown>): Promise<{ result?: unknown; error?: string }> => {
    await handleCall({ op: 'call', id: 'w', action: 'send', args: { line, ...args } });
    return out.map((l) => JSON.parse(l) as { op: string; result?: unknown; error?: string }).find((e) => e.op === 'response') ?? {};
  };

  test('sends the text first, then the card, and answers with the card id', async () => {
    const wallet = { type: 'walletSendCalls', content: request };
    expect((await call({ text: 'Layout test', wallet })).result).toEqual({ messageId: 'card-2' });
    expect(sent).toEqual(['Layout test', buildWalletContent(wallet).encoded]);
  });

  test('a bad card sends nothing, not even the text', async () => {
    expect((await call({ text: 'Layout test', wallet: { type: 'walletSendCalls', content: {} } })).error).toMatch(/content needs/);
    expect(sent).toEqual([]);
  });
});
