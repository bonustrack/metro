import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import nacl from 'tweetnacl';
import { handleCall, MAX_TEXT_BYTES } from '../src/actions.ts';
import { accounts, bootAccount } from '../src/accounts.ts';
import {
  bytesToHex,
  callbackMac,
  decode,
  encodeText,
  MSG_DELIVERY_RECEIPT,
  open,
  RECEIPT_ACK,
  RECEIPT_DECLINE,
  seal,
} from '../src/crypto.ts';

const gateway = nacl.box.keyPair();
const alice = nacl.box.keyPair();
const SECRET = 's3cret';
const LINE = 'metro://threema/t0/ECHOECHO';
const SENT_ID = '0123456789abcdef';

interface Written {
  responses: Record<string, unknown>[];
  events: Record<string, unknown>[];
}

function capture(): { written: Written; restore: () => void } {
  const written: Written = { responses: [], events: [] };
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.op === 'response') written.responses.push(parsed);
      else if (parsed.op !== 'log') written.events.push(parsed);
    }
    return true;
  }) as typeof process.stdout.write;
  return { written, restore: () => void (process.stdout.write = orig) };
}

let sends: URLSearchParams[];
let realFetch: typeof fetch;
let cap: ReturnType<typeof capture>;

const call = (action: string, args: Record<string, unknown>): Promise<void> =>
  handleCall({ op: 'call', id: 'c1', action, args });

beforeEach(() => {
  sends = [];
  accounts.set(
    't0',
    bootAccount({
      id: 't0',
      gatewayId: '*METRO01',
      secret: SECRET,
      privateKey: bytesToHex(gateway.secretKey),
      callbackId: '1493556940637339623',
      callbackToken: 'tok',
    }),
  );
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/pubkeys/ECHOECHO'))
      return Promise.resolve(new Response(bytesToHex(alice.publicKey)));
    if (url.includes('/pubkeys/')) return Promise.resolve(new Response('', { status: 404 }));
    if (url.endsWith('/send_e2e')) {
      sends.push(new URLSearchParams(String(init?.body)));
      return Promise.resolve(new Response(SENT_ID));
    }
    return Promise.resolve(new Response('', { status: 500 }));
  }) as typeof fetch;
  cap = capture();
});

afterEach(() => {
  cap.restore();
  globalThis.fetch = realFetch;
  accounts.clear();
});

const opened = (form: URLSearchParams): string => {
  const plain = open(
    new Uint8Array(Buffer.from(form.get('box') ?? '', 'hex')),
    new Uint8Array(Buffer.from(form.get('nonce') ?? '', 'hex')),
    gateway.publicKey,
    alice,
  );
  const decoded = decode(plain ?? new Uint8Array());
  return decoded.kind === 'text' ? decoded.text : `<${decoded.kind}>`;
};

describe('send', () => {
  test('seals the text for the recipient, posts it and reports the message id', async () => {
    await call('send', { line: LINE, text: 'hello' });
    expect(sends).toHaveLength(1);
    const form = sends[0] ?? new URLSearchParams();
    expect([form.get('from'), form.get('to'), form.get('secret')]).toEqual(['*METRO01', 'ECHOECHO', SECRET]);
    expect(opened(form)).toBe('hello');
    expect(cap.written.responses[0]).toEqual({
      op: 'response',
      id: 'c1',
      result: { messageId: SENT_ID, account: 't0' },
    });
    expect(cap.written.events[0]).toMatchObject({
      kind: 'outbound',
      station: 'threema',
      line: LINE,
      message_id: SENT_ID,
      text: 'hello',
    });
  });

  test('a reply is a Threema quote of the replied message', async () => {
    await call('reply', { line: LINE, text: 'yes', replyTo: 'FEDCBA9876543210' });
    expect(opened(sends[0] ?? new URLSearchParams())).toBe('> quote #fedcba9876543210\n\nyes');
    expect(cap.written.events[0]).toMatchObject({ reply_to: 'fedcba9876543210', text: 'yes' });
  });

  test('a lowercase recipient in the line still reaches the id', async () => {
    await call('send', { line: 'metro://threema/t0/echoecho', text: 'x' });
    expect(sends[0]?.get('to')).toBe('ECHOECHO');
  });

  test('no text, a bad reply target, or a text too long is refused before anything is sent', async () => {
    for (const [args, code] of [
      [{ line: LINE }, 'threema_text_required'],
      [{ line: LINE, text: 'x', replyTo: '12' }, 'threema_bad_reply_target'],
      [{ line: LINE, text: 'y'.repeat(MAX_TEXT_BYTES + 1) }, 'threema_message_too_long'],
    ] as const) {
      cap.written.responses.length = 0;
      await call('send', { ...args });
      expect(cap.written.responses[0]).toMatchObject({ errorInfo: { code } });
    }
    expect(sends).toHaveLength(0);
  });

  test('an unknown recipient is Threema refusal, named', async () => {
    await call('send', { line: 'metro://threema/t0/NOBODY01', text: 'x' });
    expect(cap.written.responses[0]).toMatchObject({ errorInfo: { code: 'threema_unknown_id' } });
  });
});

function inbound(plain: Uint8Array, over: Record<string, string> = {}): Record<string, string> {
  const { nonce, box } = seal(plain, gateway.publicKey, alice);
  const fields = {
    from: 'ECHOECHO',
    to: '*METRO01',
    messageId: 'fedcba9876543210',
    date: '1700000000',
    nonce: bytesToHex(nonce),
    box: bytesToHex(box),
    ...over,
  };
  return { account: 't0', ...fields, mac: callbackMac(SECRET, fields), nickname: 'Alice' };
}

describe('callback', () => {
  test('a text from a known sender is decrypted and emitted on the sender line', async () => {
    await call('callback', inbound(encodeText('hi there')));
    expect(cap.written.responses[0]).toEqual({ op: 'response', id: 'c1', result: { ok: true, kind: 'text' } });
    expect(cap.written.events[0]).toMatchObject({
      kind: 'inbound',
      station: 'threema',
      line: 'metro://threema/t0/ECHOECHO',
      from: 'metro://threema/t0/user/ECHOECHO',
      from_name: 'Alice',
      message_id: 'fedcba9876543210',
      text: 'hi there',
      is_private: true,
      ts: '2023-11-14T22:13:20.000Z',
      account: 't0',
    });
    expect(cap.written.events[0]).not.toHaveProperty('reply_to');
  });

  test('a quoted text is a reply, and a quote of our own message says so', async () => {
    await call('send', { line: LINE, text: 'question' });
    await call('callback', inbound(encodeText(`> quote #${SENT_ID}\n\nanswer`)));
    expect(cap.written.events[1]).toMatchObject({
      text: 'answer',
      reply_to: SENT_ID,
      reply_to_self: true,
      event: { type: 'reply', replyTo: SENT_ID },
    });
  });

  test('a thumbs-up or thumbs-down receipt is a reaction on the acknowledged message', async () => {
    const receipt = (status: number): Uint8Array =>
      new Uint8Array(Buffer.concat([Buffer.from([MSG_DELIVERY_RECEIPT, status]), Buffer.from(SENT_ID, 'hex')]));
    await call('callback', inbound(receipt(RECEIPT_ACK)));
    await call('callback', inbound(receipt(RECEIPT_DECLINE), { messageId: 'aaaaaaaaaaaaaaaa' }));
    await call('callback', inbound(receipt(0x01), { messageId: 'bbbbbbbbbbbbbbbb' }));
    expect(cap.written.events.map((e) => [e.emoji, (e.event as { targetId?: string }).targetId])).toEqual([
      ['👍', SENT_ID],
      ['👎', SENT_ID],
    ]);
    expect(cap.written.responses.map((r) => (r.result as { kind: string }).kind)).toEqual([
      'reaction',
      'reaction',
      'receipt:1',
    ]);
  });

  test('a type the station does not carry is acknowledged and ignored', async () => {
    await call('callback', inbound(new Uint8Array([0x17, 0x7b, 0x7d])));
    expect(cap.written.responses[0]).toMatchObject({ result: { ok: true, kind: 'ignored:0x17' } });
    expect(cap.written.events).toHaveLength(0);
  });

  test('a wrong MAC, a foreign recipient or a missing field is refused and emits nothing', async () => {
    const good = inbound(encodeText('x'));
    for (const [args, code] of [
      [{ ...good, mac: 'ff'.repeat(32) }, 'threema_bad_mac'],
      [{ ...good, box: 'ee'.repeat(20) }, 'threema_bad_mac'],
      [inbound(encodeText('x'), { to: '*OTHER01' }), 'threema_wrong_recipient'],
      [{ ...good, nonce: '' }, 'threema_bad_callback'],
      [{ ...good, account: 't9' }, undefined],
    ] as const) {
      cap.written.responses.length = 0;
      await call('callback', { ...args });
      if (code === undefined) expect(cap.written.responses[0]).toHaveProperty('error');
      else expect(cap.written.responses[0]).toMatchObject({ errorInfo: { code } });
    }
    expect(cap.written.events).toHaveLength(0);
  });

  test('a box that does not open with our key is refused', async () => {
    const eve = nacl.box.keyPair();
    const { nonce, box } = seal(encodeText('x'), eve.publicKey, alice);
    const fields = { from: 'ECHOECHO', to: '*METRO01', messageId: 'fedcba9876543210', date: '1', nonce: bytesToHex(nonce), box: bytesToHex(box) };
    await call('callback', { account: 't0', ...fields, mac: callbackMac(SECRET, fields) });
    expect(cap.written.responses[0]).toMatchObject({ errorInfo: { code: 'threema_undecryptable' } });
  });
});

describe('accounts', () => {
  test('reports the gateway id as the handle plus the callback parts the daemon turns into a url', async () => {
    await call('accounts', {});
    expect(cap.written.responses[0]).toEqual({
      op: 'response',
      id: 'c1',
      result: {
        accounts: [
          {
            id: 't0',
            handle: '*METRO01',
            url: null,
            owner: null,
            gatewayId: '*METRO01',
            callbackId: '1493556940637339623',
            callbackToken: 'tok',
          },
        ],
      },
    });
  });
});
