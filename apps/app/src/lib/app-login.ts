import { openAuthSessionAsync } from 'expo-web-browser';
import { CryptoDigestAlgorithm, CryptoEncoding, digestStringAsync, getRandomBytes } from 'expo-crypto';
import { exchangeHandoff, loginUrl, type Intent, type Provider } from '@metro-labs/client/api/auth';
import { handoffCode } from '@metro-labs/client/auth/account';
import { land } from './land.js';

const RETURN = 'metro://auth';

const base64url = (text: string): string => text.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function randomVerifier(): string {
  let text = '';
  for (const byte of getRandomBytes(32)) text += String.fromCharCode(byte);
  return base64url(btoa(text));
}

export async function appLogin(provider: Provider, intent: Intent): Promise<void> {
  const verifier = randomVerifier();
  const challenge = base64url(await digestStringAsync(CryptoDigestAlgorithm.SHA256, verifier, { encoding: CryptoEncoding.BASE64 }));
  const result = await openAuthSessionAsync(loginUrl(provider, intent, { returnTo: RETURN, challenge }), RETURN);
  if (result.type !== 'success') return;
  const hash = result.url.slice(result.url.indexOf('#'));
  const code = handoffCode(hash);
  if (code === null) {
    land(hash);
    return;
  }
  await exchangeHandoff(code, verifier);
  land('#/');
}
