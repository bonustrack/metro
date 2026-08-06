import { describe, expect, test } from 'bun:test';
import makeWASocket, {
  Browsers,
  Curve,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  hkdf,
  initAuthCreds,
  md5,
  proto,
  signedKeyPair,
} from 'baileys';

describe('Baileys 7 under Bun', () => {
  test('every export the station uses is still there', () => {
    expect(typeof makeWASocket).toBe('function');
    expect(typeof fetchLatestWaWebVersion).toBe('function');
    expect(typeof downloadMediaMessage).toBe('function');
    expect(typeof initAuthCreds).toBe('function');
    expect(Browsers.macOS('Safari')[1]).toBe('Safari');
    expect(DisconnectReason.loggedOut).toBe(401);
    expect(proto.WebMessageInfo.Status.DELIVERY_ACK).toBe(3);
  });

  test('the WASM bridge instantiates and computes, so hkdf and md5 are live', async () => {
    const out = await hkdf(Buffer.alloc(32, 7), 32, { info: 'metro' });
    expect(out.length).toBe(32);
    expect(Buffer.from(out).toString('hex')).not.toBe('0'.repeat(64));
    expect(Buffer.from(await md5(Buffer.from('abc'))).toString('hex')).toBe(
      '900150983cd24fb0d6963f7d28e17f72',
    );
  });

  test('libsignal curve25519 agrees with itself and verifies its own signatures', () => {
    const a = Curve.generateKeyPair();
    const b = Curve.generateKeyPair();
    expect(Buffer.from(Curve.sharedKey(a.private, b.public))).toEqual(
      Buffer.from(Curve.sharedKey(b.private, a.public)),
    );
    const signed = Curve.sign(a.private, Buffer.from('metro'));
    expect(Curve.verify(a.public, Buffer.from('metro'), signed)).toBe(true);
    expect(signedKeyPair(a, 1).signature.length).toBe(64);
  });

  test('fresh creds are shaped like the blob the DB already holds', () => {
    const creds = initAuthCreds();
    expect(creds.registered).toBe(false);
    expect(creds.noiseKey.private.length).toBe(32);
    expect(creds.signedIdentityKey.public.length).toBe(32);
    expect(typeof creds.advSecretKey).toBe('string');
  });
});
