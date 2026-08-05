import {
  assertAttachmentSize,
  assertContentLength,
  guessMime,
  saveBufferToCache,
} from './attachments.js';
import type { CanonicalAttachment } from './types.js';

export interface ResolvedAttachment {
  path: string;
  mime: string;
  name: string;
  bytes: number;
}

const FETCH_TIMEOUT_MS = 60_000;

const basenameOf = (src: string): string =>
  src.split('?')[0]?.split('#')[0]?.split('/').filter(Boolean).pop() ?? '';

const isHttpUrl = (src: string): boolean => /^https?:\/\//i.test(src);

const mintId = (): string => Math.random().toString(36).slice(2, 12);

async function fromPath(
  a: CanonicalAttachment,
  path: string,
): Promise<ResolvedAttachment> {
  const file = Bun.file(path);
  if (!(await file.exists()))
    throw new Error(
      `attachment path '${path}' does not exist on the metro host. ` +
        '`path` is read on the daemon machine, not on the caller\'s machine; ' +
        'pass `url` instead if the file is not already on the daemon.',
    );
  assertAttachmentSize(file.size);
  return {
    path,
    mime: a.mime ?? guessMime(path),
    name: a.name ?? basenameOf(path) ?? 'attachment',
    bytes: file.size,
  };
}

async function fromUrl(
  a: CanonicalAttachment,
  url: string,
): Promise<ResolvedAttachment> {
  if (!isHttpUrl(url))
    throw new Error(
      `attachment url '${url}' is not an http(s) url; use \`path\` for a local file`,
    );
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok)
    throw new Error(`attachment fetch failed ${res.status} for '${url}'`);
  assertContentLength(res.headers.get('content-length'));
  const data = new Uint8Array(await res.arrayBuffer());
  const mime =
    a.mime ?? res.headers.get('content-type')?.split(';')[0] ?? guessMime(url);
  const name = a.name ?? basenameOf(url) ?? 'attachment';
  const saved = await saveBufferToCache(data, `out${mintId()}`, 0, {
    mime,
    name,
  });
  return { path: saved.path, mime, name, bytes: data.length };
}

export async function resolveAttachment(
  a: CanonicalAttachment,
): Promise<ResolvedAttachment> {
  if (a.path) return fromPath(a, a.path);
  if (a.url) return fromUrl(a, a.url);
  throw new Error('attachment requires `path` or `url`');
}

export async function resolveAttachments(
  atts: CanonicalAttachment[],
): Promise<ResolvedAttachment[]> {
  const out: ResolvedAttachment[] = [];
  for (let i = 0; i < atts.length; i++) {
    const a = atts[i];
    if (!a) continue;
    try {
      out.push(await resolveAttachment(a));
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(`attachment ${i + 1} of ${atts.length}: ${why}`);
    }
  }
  return out;
}
