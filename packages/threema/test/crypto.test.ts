import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import nacl from 'tweetnacl';
import {
  bytesToHex,
  callbackMac,
  decode,
  encodeText,
  keyPairFrom,
  macMatches,
  MSG_DELIVERY_RECEIPT,
  MSG_TYPING,
  open,
  quoted,
  RECEIPT_ACK,
  seal,
  unquote,
} from '../src/crypto.ts';

const alice = nacl.box.keyPair();
const bob = nacl.box.keyPair();

describe('the NaCl box every Threema message travels in', () => {
  test('a sealed text opens on the other side whatever padding was drawn', () => {
    for (let i = 0; i < 40; i++) {
      const { nonce, box } = seal(encodeText('hi 👋'), bob.publicKey, alice);
      expect(box.length).toBeGreaterThanOrEqual(1 + 6 + 1 + 16);
      expect(box.length).toBeLessThanOrEqual(1 + 6 + 255 + 16);
      const plain = open(box, nonce, alice.publicKey, bob);
      expect(plain).not.toBeNull();
      expect(decode(plain ?? new Uint8Array())).toEqual({ kind: 'text', text: 'hi 👋' });
    }
  });

  test('a key pair derived from the hex private key is the one nacl derives', () => {
    const pair = keyPairFrom(bytesToHex(alice.secretKey));
    expect(bytesToHex(pair.publicKey)).toBe(bytesToHex(alice.publicKey));
    expect(() => keyPairFrom('zz')).toThrow('not hex');
  });

  test('a box sealed for someone else stays closed', () => {
    const { nonce, box } = seal(encodeText('secret'), bob.publicKey, alice);
    const eve = nacl.box.keyPair();
    expect(open(box, nonce, alice.publicKey, eve)).toBeNull();
    box[3] = (box[3] ?? 0) ^ 0xff;
    expect(open(box, nonce, alice.publicKey, bob)).toBeNull();
  });

  test('padding that claims zero or more bytes than exist is refused', () => {
    const nonce = nacl.randomBytes(24);
    const zero = nacl.box(Buffer.from([0x01, 0x41, 0x00]), nonce, bob.publicKey, alice.secretKey);
    expect(open(zero, nonce, alice.publicKey, bob)).toBeNull();
    const huge = nacl.box(Buffer.from([0x01, 0x41, 0x09]), nonce, bob.publicKey, alice.secretKey);
    expect(open(huge, nonce, alice.publicKey, bob)).toBeNull();
    const exact = nacl.box(Buffer.from([0x01, 0x41, 0x01]), nonce, bob.publicKey, alice.secretKey);
    expect(decode(open(exact, nonce, alice.publicKey, bob) ?? new Uint8Array())).toEqual({ kind: 'text', text: 'A' });
  });

  test('a delivery receipt carries its status and every 8-byte message id', () => {
    const receipt = Buffer.concat([
      Buffer.from([MSG_DELIVERY_RECEIPT, RECEIPT_ACK]),
      Buffer.from('0123456789abcdef', 'hex'),
      Buffer.from('fedcba9876543210', 'hex'),
    ]);
    expect(decode(receipt)).toEqual({
      kind: 'receipt',
      status: RECEIPT_ACK,
      messageIds: ['0123456789abcdef', 'fedcba9876543210'],
    });
    expect(decode(Buffer.from([MSG_TYPING, 0x01]))).toEqual({ kind: 'typing' });
    expect(decode(Buffer.from([0x17, 0x7b]))).toEqual({ kind: 'other', type: 0x17 });
    expect(decode(new Uint8Array())).toEqual({ kind: 'other', type: -1 });
  });
});

describe('the callback MAC', () => {
  const fields = {
    from: 'ECHOECHO',
    to: '*METRO01',
    messageId: '0123456789abcdef',
    date: '1700000000',
    nonce: 'aa'.repeat(24),
    box: 'bb'.repeat(40),
  };

  test('is HMAC-SHA256 over the six fields concatenated, keyed by the API secret', () => {
    const want = createHmac('sha256', 's3cret')
      .update(`${fields.from}${fields.to}${fields.messageId}${fields.date}${fields.nonce}${fields.box}`)
      .digest('hex');
    expect(callbackMac('s3cret', fields)).toBe(want);
    expect(macMatches('s3cret', fields, want)).toBe(true);
    expect(macMatches('s3cret', fields, want.toUpperCase())).toBe(true);
  });

  test('a changed field, another secret or junk never matches', () => {
    const mac = callbackMac('s3cret', fields);
    expect(macMatches('other', fields, mac)).toBe(false);
    expect(macMatches('s3cret', { ...fields, box: 'cc'.repeat(40) }, mac)).toBe(false);
    expect(macMatches('s3cret', fields, 'not hex at all')).toBe(false);
    expect(macMatches('s3cret', fields, '')).toBe(false);
  });
});

describe('quotes', () => {
  test('a reply is a Threema quote, and an inbound quote is read back as a reply', () => {
    expect(quoted('0123456789abcdef', 'yes')).toBe('> quote #0123456789abcdef\n\nyes');
    expect(unquote('> quote #0123456789abcdef\n\nyes')).toEqual({ replyTo: '0123456789abcdef', text: 'yes' });
    expect(unquote('> quote #nope\n\nyes')).toEqual({ text: '> quote #nope\n\nyes' });
    expect(unquote('plain')).toEqual({ text: 'plain' });
  });
});
