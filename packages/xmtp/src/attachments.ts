import {
  AttachmentCodec,
  RemoteAttachmentCodec,
  ContentTypeAttachment,
} from '@xmtp/content-type-remote-attachment';
import {
  saveBufferToCache,
  assertAttachmentSize,
} from '@metro-labs/core/stations/attachments';
import type { SavedAttachment } from '@metro-labs/core/stations/attachments';
import { errMsg } from '@metro-labs/core/log';

export type { SavedAttachment };

const READ_RETRY_DELAYS_MS: readonly number[] = [400, 800];
export const REMOTE_FETCH_ATTEMPTS = READ_RETRY_DELAYS_MS.length + 1;
export const INBOUND_RETRY_DELAYS_MS: readonly number[] = [
  2_000, 4_000, 8_000, 15_000, 30_000, 30_000,
  60_000, 60_000, 60_000, 60_000, 60_000, 60_000,
];
const REMOTE_FETCH_TIMEOUT_MS = 120_000;
const SWARM_FALLBACK_GATEWAY = 'https://download.gateway.ethswarm.org/bzz/';
const SWARM_BZZ_URL = /^https:\/\/[^/]+\/bzz\/([0-9a-f]{64}(?:[0-9a-f]{64})?)\/?$/i;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const attachmentCodec = new AttachmentCodec();
const loadRegistry = {
  codecFor: (ct: { typeId?: string }) =>
    ct.typeId === ContentTypeAttachment.typeId ? attachmentCodec : undefined,
};

export interface RemoteEntry {
  url: string;
  filename?: string;
  contentDigest?: string;
  nonce?: Uint8Array;
  salt?: Uint8Array;
  secret?: Uint8Array;
  scheme?: string;
  contentLength?: number;
}

export async function saveInlineAttachment(
  a: { filename?: string; mimeType?: string; content: Uint8Array },
  messageId: string,
  index = 0,
): Promise<SavedAttachment> {
  return saveBufferToCache(a.content, messageId, index, {
    mime: a.mimeType,
    name: a.filename,
  });
}

function toRemoteDescriptor(r: RemoteEntry): {
  url: string;
  contentDigest: string;
  salt: Uint8Array;
  nonce: Uint8Array;
  secret: Uint8Array;
  scheme: string;
  contentLength: number;
  filename: string;
} {
  return {
    url: r.url,
    contentDigest: r.contentDigest ?? '',
    salt: r.salt ?? new Uint8Array(),
    nonce: r.nonce ?? new Uint8Array(),
    secret: r.secret ?? new Uint8Array(),
    scheme: r.scheme ?? 'https://',
    contentLength: r.contentLength ?? 0,
    filename: r.filename ?? '',
  };
}

interface DecodedAttachment {
  filename?: string;
  mimeType?: string;
  data: Uint8Array;
}

function remoteUrls(url: string): string[] {
  const ref = SWARM_BZZ_URL.exec(url)?.[1];
  const fallback = ref === undefined ? url : `${SWARM_FALLBACK_GATEWAY}${ref}/`;
  return fallback === url ? [url] : [url, fallback];
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no answer within ${ms / 1000}s`));
    }, ms);
  });
  return Promise.race([work, expired]).finally(() => {
    clearTimeout(timer);
  });
}

function loadFrom(r: RemoteEntry, url: string): Promise<DecodedAttachment> {
  return withTimeout(
    RemoteAttachmentCodec.load<DecodedAttachment>(
      { ...toRemoteDescriptor(r), url },
      loadRegistry,
    ),
    REMOTE_FETCH_TIMEOUT_MS,
  );
}

async function loadRemote(
  r: RemoteEntry,
  retryDelaysMs: readonly number[],
): Promise<DecodedAttachment> {
  const urls = remoteUrls(r.url);
  let last = '';
  for (const delay of [0, ...retryDelaysMs]) {
    if (delay > 0) await sleep(delay);
    const errors: string[] = [];
    for (const url of urls) {
      try {
        return await loadFrom(r, url);
      } catch (err) {
        errors.push(errMsg(err));
      }
    }
    last = errors.join('; ');
  }
  throw new Error(
    `xmtp remote attachment fetch failed after ${retryDelaysMs.length + 1} attempts: ${last}`,
  );
}

export async function saveRemoteAttachment(
  r: RemoteEntry,
  messageId: string,
  index = 0,
  retryDelaysMs: readonly number[] = READ_RETRY_DELAYS_MS,
): Promise<SavedAttachment> {
  if (r.contentLength) assertAttachmentSize(r.contentLength);
  const decoded = await loadRemote(r, retryDelaysMs);
  return saveBufferToCache(decoded.data, messageId, index, {
    mime: decoded.mimeType,
    name: decoded.filename ?? r.filename,
  });
}
