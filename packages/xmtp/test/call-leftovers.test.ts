import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { accounts, type Account } from '../src/accounts.ts';
import { handleCall } from '../src/actions.ts';

const accountId = 'calls-test';
const self = 'self-inbox';
const signalType = { authorityId: 'stage.box', typeId: 'callSignal', versionMajor: 1, versionMinor: 0 };
const textType = { authorityId: 'xmtp.org', typeId: 'text', versionMajor: 1, versionMinor: 0 };

interface Stored {
  senderInboxId: string;
  contentType: typeof signalType;
  content: unknown;
}

const signal = (content: Record<string, unknown>, sender = self): Stored => ({ senderInboxId: sender, contentType: signalType, content });

let out: string[] = [];
let restore = () => {};
let asked: unknown[] = [];

beforeEach(() => {
  out = [];
  asked = [];
  const spy = spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  restore = () => spy.mockRestore();
});
afterEach(() => {
  restore();
  accounts.delete(accountId);
});

function fixture(convs: Record<string, Stored[]>): void {
  const list = Object.entries(convs).map(([id, messages]) => ({
    id,
    messages: async (opts: unknown) => {
      asked.push(opts);
      return [...messages].reverse();
    },
  }));
  const client = { inboxId: self, conversations: { list: async () => list } };
  accounts.set(accountId, { cfg: { id: accountId }, client, inboxId: self } as unknown as Account);
}

async function leftovers(): Promise<{ result?: { calls: unknown[] }; error?: string }> {
  await handleCall({ op: 'call', id: 'l', action: 'callLeftovers', args: {} });
  const response = out.map((l) => JSON.parse(l) as { op: string }).find((e) => e.op === 'response');
  return response as { result?: { calls: unknown[] }; error?: string };
}

describe('xmtp callLeftovers', () => {
  test('finds the calls this inbox joined and never left', async () => {
    fixture({
      g1: [
        signal({ kind: 'join', callId: 'call-1', from: 'peer-a' }),
        signal({ kind: 'answer', callId: 'call-1', from: 'peer-a', to: 'caller', sdp: 'v=0' }),
        signal({ kind: 'leave', callId: 'call-1', from: 'caller' }, 'caller-inbox'),
      ],
      g2: [
        signal({ kind: 'join', callId: 'call-2', from: 'peer-b' }),
        signal({ kind: 'leave', callId: 'call-2', from: 'peer-b' }),
        { senderInboxId: self, contentType: textType, content: 'hi' },
      ],
      g3: [signal({ kind: 'join', callId: 'call-3', from: 'peer-c' }, 'caller-inbox')],
    });
    expect((await leftovers()).result).toEqual({
      calls: [{ line: `metro://xmtp/${accountId}/g1`, callId: 'call-1', peer: 'peer-a' }],
    });
    const { sentAfterNs, ...rest } = asked[0] as { sentAfterNs: bigint };
    expect(rest).toEqual({ direction: 1, limit: 100 });
    const dayAgoNs = BigInt(Date.now() - 24 * 60 * 60_000) * 1_000_000n;
    expect(Number((dayAgoNs - sentAfterNs) / 1_000_000n)).toBeLessThan(5_000);
  });

  test('says when no account is ready yet', async () => {
    expect((await leftovers()).error).toContain('no XMTP account is ready yet');
  });
});
