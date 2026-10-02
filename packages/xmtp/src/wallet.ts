import type { EncodedContent } from '@xmtp/content-type-primitives';
import {
  SignatureReferenceCodec,
  SignatureRequestCodec,
  TransactionReferenceCodec,
  WalletSendCallsCodec,
} from './codecs.js';
import { bad, isNode, parseJson } from './frames.js';

const WALLET_TYPES: Record<string, { codec: { encode(c: Record<string, unknown>): EncodedContent }; needs: string[] }> = {
  walletSendCalls: { codec: new WalletSendCallsCodec(), needs: ['version', 'chainId', 'from', 'calls'] },
  transactionReference: { codec: new TransactionReferenceCodec(), needs: ['networkId', 'reference'] },
  signatureRequest: { codec: new SignatureRequestCodec(), needs: ['id', 'kind'] },
  signatureReference: { codec: new SignatureReferenceCodec(), needs: ['requestId', 'signature', 'signer'] },
};

export function buildWalletContent(raw: unknown): { encoded: EncodedContent; summary: string } {
  const args = parseJson(raw, 'wallet');
  const type = isNode(args) && typeof args.type === 'string' ? args.type : '';
  const spec = Object.hasOwn(WALLET_TYPES, type) ? WALLET_TYPES[type] : undefined;
  if (!isNode(args) || !spec) throw bad(`wallet type must be one of ${Object.keys(WALLET_TYPES).join(', ')}`);
  const content = parseJson(args.content, 'wallet content');
  if (!isNode(content)) throw bad(`wallet content must be the ${type} JSON object`);
  const missing = spec.needs.filter((key) => content[key] === undefined);
  if (missing.length > 0) throw bad(`${type} content needs ${missing.join(', ')}`);
  const encoded = spec.codec.encode(content);
  return { encoded, summary: encoded.fallback ?? type };
}
