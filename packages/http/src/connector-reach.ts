import { errMsg } from '@metro-labs/core/log';

const HINTS: Record<string, string> = {
  ENOTFOUND: 'the name does not resolve',
  EAI_AGAIN: 'the name did not resolve in time',
  ECONNREFUSED: 'nothing is listening there',
  ECONNRESET: 'the server dropped the connection',
  ETIMEDOUT: 'the server did not answer in time',
  ConnectionRefused: 'nothing is listening there',
  CERT_HAS_EXPIRED: 'its certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'its certificate is self-signed',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'its certificate could not be verified',
  ERR_TLS_CERT_ALTNAME_INVALID: 'its certificate is for another name',
  SELF_SIGNED_CERT_IN_CHAIN: 'its certificate chain is not trusted',
};

const codeOf = (err: unknown): string =>
  err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : '';

export function whyUnreachable(err: unknown): string {
  const inner = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  const message = errMsg(inner).trim();
  const code = codeOf(inner) || codeOf(err);
  const said = message !== '' && message !== 'fetch failed' ? message : code || 'no answer';
  const hint = HINTS[code];
  return hint === undefined ? said : `${said} (${hint})`;
}
