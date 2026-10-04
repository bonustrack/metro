import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha2';
import { gcm } from '@noble/ciphers/aes';
import { gunzipSync, gzipSync, strToU8 } from 'fflate';
import { buffer } from './bytes.js';

export interface Sealing {
  passphrase: string;
  salt: Uint8Array;
  iterations: number;
  nonce: Uint8Array;
  aad: Uint8Array;
}

const utf8 = (s: string): Uint8Array => strToU8(s);

const subtle = (): SubtleCrypto | null => (typeof crypto === 'object' && typeof crypto.subtle === 'object' ? crypto.subtle : null);

const hasStreams = (): boolean => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

async function webKey(web: SubtleCrypto, s: Sealing): Promise<CryptoKey> {
  const material = await web.importKey('raw', buffer(utf8(s.passphrase.normalize('NFKC'))), 'PBKDF2', false, ['deriveKey']);
  return web.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: buffer(s.salt), iterations: s.iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const rawKey = (s: Sealing): Promise<Uint8Array> => pbkdf2Async(sha256, utf8(s.passphrase.normalize('NFKC')), s.salt, { c: s.iterations, dkLen: 32 });

export async function sealBytes(s: Sealing, plain: Uint8Array): Promise<Uint8Array> {
  const web = subtle();
  if (web !== null) return new Uint8Array(await web.encrypt({ name: 'AES-GCM', iv: buffer(s.nonce), additionalData: buffer(s.aad) }, await webKey(web, s), buffer(plain)));
  return gcm(await rawKey(s), s.nonce, s.aad).encrypt(plain);
}

export async function openBytes(s: Sealing, sealed: Uint8Array): Promise<Uint8Array> {
  const web = subtle();
  if (web !== null) return new Uint8Array(await web.decrypt({ name: 'AES-GCM', iv: buffer(s.nonce), additionalData: buffer(s.aad) }, await webKey(web, s), buffer(sealed)));
  return gcm(await rawKey(s), s.nonce, s.aad).decrypt(sealed);
}

export async function sha256Hex(text: string): Promise<string> {
  const web = subtle();
  const bytes = web === null ? sha256(utf8(text)) : new Uint8Array(await web.digest('SHA-256', buffer(utf8(text))));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function through(bytes: Uint8Array, stream: ReadableWritablePair<Uint8Array, BufferSource>): Promise<Uint8Array> {
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(owned);
      controller.close();
    },
  });
  return new Uint8Array(await new Response(source.pipeThrough(stream)).arrayBuffer());
}

export const gzipBytes = (bytes: Uint8Array): Promise<Uint8Array> =>
  hasStreams() ? through(bytes, new CompressionStream('gzip')) : Promise.resolve(gzipSync(bytes));

export const gunzipBytes = (bytes: Uint8Array): Promise<Uint8Array> =>
  hasStreams() ? through(bytes, new DecompressionStream('gzip')) : Promise.resolve(gunzipSync(bytes));
