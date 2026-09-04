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
  splitInlineData,
  writeInlineTemp,
} from './attach-inline.js';
import { realpathSync } from 'node:fs';
import { readUpload, UPLOAD_TTL_MS } from '../daemon/upload-store.js';
import type { CanonicalAttachment } from './types.js';

export interface ResolvedAttachment {
  path: string;
  mime: string;
  name: string;
  bytes: number;
  temp?: string;
}

export interface ResolveOptions {
  allowed?: Set<string>;
}

interface InlineBudget {
  used: number;
}

const FETCH_TIMEOUT_MS = 60_000;

const basenameOf = (src: string): string =>
  src.split('?')[0]?.split('#')[0]?.split('/').filter(Boolean).pop() ?? '';

const isHttpUrl = (src: string): boolean => /^https?:\/\//i.test(src);

const mintId = (): string => Math.random().toString(36).slice(2, 12);

const HIDDEN_SEGMENT = /(^|\/)\.[^/]/;

function assertReadablePath(path: string): void {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return;
  }
  if (HIDDEN_SEGMENT.test(real))
    throw new Error(
      `attachment path '${path}' resolves into a hidden directory ` +
        `('${real}') and will not be read. \`path\` is read on the daemon ` +
        'machine; put the file somewhere non-hidden or pass `upload` instead.',
    );
}

async function fromPath(
  a: CanonicalAttachment,
  path: string,
): Promise<ResolvedAttachment> {
  assertReadablePath(path);
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
  const source = splitInlineData(data);
  const bytes = decodeInline(source.data, `'${name}'`);
  budget.used += bytes.length;
  assertInlineTotal(budget.used);
  const { dir, path } = await writeInlineTemp(bytes, a.name);
  return {
    path,
    mime: a.mime ?? source.mime ?? guessMime(name),
    name,
    bytes: bytes.length,
    temp: dir,
  };
}

const uploadMissing = (id: string): Error =>
  new Error(
    `upload '${id}' is not a live upload of yours. Either it was never created, or its ` +
      'bytes were never pushed to `POST /api/uploads`, or it belongs to another agent, or ' +
      `it expired (an upload lives ${Math.round(UPLOAD_TTL_MS / 60_000)} minutes). ` +
      'Create a new one with `create_upload` and push the file again.',
  );

function fromUpload(
  a: CanonicalAttachment,
  id: string,
  allowed: Set<string> | undefined,
): ResolvedAttachment {
  const rec = allowed === undefined ? undefined : readUpload(id);
  if (rec === undefined || !(allowed?.has(rec.agentId) ?? false))
    throw uploadMissing(id);
  const name = a.name ?? rec.name;
  return { path: rec.path, mime: a.mime ?? rec.mime, name, bytes: rec.bytes };
}

export const SOURCE_KEYS = ['path', 'url', 'data', 'upload'] as const;

const sourcesOf = (a: CanonicalAttachment): string[] =>
  SOURCE_KEYS.filter((k) => {
    const v = a[k];
    return typeof v === 'string' && v.length > 0;
  });

async function resolveAttachment(
  a: CanonicalAttachment,
  budget: InlineBudget = { used: 0 },
  opts: ResolveOptions = {},
): Promise<ResolvedAttachment> {
  const sources = sourcesOf(a);
  if (sources.length === 0)
    throw new Error(
      'attachment requires exactly one of `upload`, `data`, `url` or `path`',
    );
  if (sources.length > 1)
    throw new Error(
      `attachment names ${sources.length} sources (${sources
        .map((s) => `\`${s}\``)
        .join(', ')}); pass exactly one of \`upload\`, \`data\`, \`url\` or \`path\``,
    );
  if (a.upload) return fromUpload(a, a.upload, opts.allowed);
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
  opts: ResolveOptions = {},
): Promise<ResolvedAttachment[]> {
  const out: ResolvedAttachment[] = [];
  const budget: InlineBudget = { used: 0 };
  for (let i = 0; i < atts.length; i++) {
    const a = atts[i];
    if (!a) continue;
    try {
      out.push(await resolveAttachment(a, budget, opts));
    } catch (e) {
      await cleanupAttachments(out);
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(`attachment ${i + 1} of ${atts.length}: ${why}`);
    }
  }
  return out;
}
