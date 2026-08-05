import {
  assertAttachmentSize,
  assertContentLength,
  guessMime,
  saveBufferToCache,
} from './attachments.js';
import {
  assertInlineTotal,
  decodeInline,
  removeInlineTemp,
  writeInlineTemp,
} from './attach-inline.js';
import type { CanonicalAttachment } from './types.js';

export interface ResolvedAttachment {
  path: string;
  mime: string;
  name: string;
  bytes: number;
  temp?: string;
}

interface InlineBudget {
  used: number;
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

async function fromData(
  a: CanonicalAttachment,
  data: string,
  budget: InlineBudget,
): Promise<ResolvedAttachment> {
  const name = a.name ?? 'attachment';
  const bytes = decodeInline(data, `'${name}'`);
  budget.used += bytes.length;
  assertInlineTotal(budget.used);
  const { dir, path } = await writeInlineTemp(bytes, a.name);
  return {
    path,
    mime: a.mime ?? guessMime(name),
    name,
    bytes: bytes.length,
    temp: dir,
  };
}

const SOURCE_KEYS = ['path', 'url', 'data'] as const;

const sourcesOf = (a: CanonicalAttachment): string[] =>
  SOURCE_KEYS.filter((k) => {
    const v = a[k];
    return typeof v === 'string' && v.length > 0;
  });

export async function resolveAttachment(
  a: CanonicalAttachment,
  budget: InlineBudget = { used: 0 },
): Promise<ResolvedAttachment> {
  const sources = sourcesOf(a);
  if (sources.length === 0)
    throw new Error(
      'attachment requires `path` or `url` or inline base64 `data` (exactly one)',
    );
  if (sources.length > 1)
    throw new Error(
      `attachment names ${sources.length} sources (${sources
        .map((s) => `\`${s}\``)
        .join(', ')}); pass exactly one of \`path\`, \`url\` or \`data\``,
    );
  if (a.data) return fromData(a, a.data, budget);
  if (a.path) return fromPath(a, a.path);
  return fromUrl(a, a.url ?? '');
}

export async function cleanupAttachments(
  atts: ResolvedAttachment[],
): Promise<void> {
  for (const a of atts) if (a.temp) await removeInlineTemp(a.temp);
}

export async function resolveAttachments(
  atts: CanonicalAttachment[],
): Promise<ResolvedAttachment[]> {
  const out: ResolvedAttachment[] = [];
  const budget: InlineBudget = { used: 0 };
  for (let i = 0; i < atts.length; i++) {
    const a = atts[i];
    if (!a) continue;
    try {
      out.push(await resolveAttachment(a, budget));
    } catch (e) {
      await cleanupAttachments(out);
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(`attachment ${i + 1} of ${atts.length}: ${why}`);
    }
  }
  return out;
}
