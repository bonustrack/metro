import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MAX_INLINE_BYTES = 8 * 1024 * 1024;

const INLINE_TEMP_PREFIX = 'metro-inline-';

const BASE64_RE = /^[A-Za-z0-9+/_-]*={0,2}$/;

const mib = (n: number): string => `${(n / (1024 * 1024)).toFixed(2)} MiB`;

const LIMIT_HINT =
  `inline \`data\` is capped at ${mib(MAX_INLINE_BYTES)} (${MAX_INLINE_BYTES} bytes) of decoded ` +
  'bytes per attachment and per send, because the base64 travels inside the MCP request body. ' +
  'Pass `url`, or a `path` already on the daemon host, for anything larger.';

function assertInlineSize(bytes: number, label: string): void {
  if (bytes > MAX_INLINE_BYTES)
    throw new Error(`inline attachment ${label} is ${mib(bytes)}; ${LIMIT_HINT}`);
}

export function assertInlineTotal(bytes: number): void {
  if (bytes > MAX_INLINE_BYTES)
    throw new Error(
      `inline attachments total ${mib(bytes)} in one send; ${LIMIT_HINT}`,
    );
}

const padOf = (b64: string): number =>
  b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;

export const decodedLengthOf = (b64: string): number =>
  Math.max(0, Math.floor((b64.length * 3) / 4) - padOf(b64));

const malformed = (why: string): Error =>
  new Error(
    `inline \`data\` ${why}; pass the file's bytes base64-encoded ` +
      '(standard or url-safe alphabet, optionally behind a `data:<mime>;base64,` prefix)',
  );

const DATA_URL_RE = /^data:([^,]*),/i;

export interface InlineSource {
  data: string;
  mime?: string;
}

export function splitInlineData(raw: string): InlineSource {
  const compact = raw.replace(/\s+/g, '');
  const match = DATA_URL_RE.exec(compact);
  if (!match) return { data: raw };
  const params = (match[1] ?? '').split(';');
  if (!params.slice(1).some((p) => p.toLowerCase() === 'base64'))
    throw malformed('is a `data:` url whose payload is not base64');
  const mime = params[0]?.toLowerCase();
  const data = compact.slice(match[0].length);
  return mime === undefined || mime === '' ? { data } : { data, mime };
}

export function decodeInline(raw: string, label: string): Uint8Array {
  const b64 = raw.replace(/\s+/g, '');
  if (!b64) throw malformed('is empty');
  const expected = decodedLengthOf(b64);
  assertInlineSize(expected, label);
  if (!BASE64_RE.test(b64)) throw malformed('is not base64');
  if (b64.length % 4 === 1 || (padOf(b64) > 0 && b64.length % 4 !== 0))
    throw malformed('is not a whole number of base64 quanta');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== expected)
    throw malformed(`decoded to ${buf.length} bytes instead of ${expected}`);
  return new Uint8Array(buf);
}

export const safeFileName = (name: string | undefined): string => {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 64);
  return clean || 'attachment';
};

export interface InlineTemp {
  dir: string;
  path: string;
}

export async function writeInlineTemp(
  data: Uint8Array,
  name: string | undefined,
): Promise<InlineTemp> {
  const dir = await mkdtemp(join(tmpdir(), INLINE_TEMP_PREFIX));
  const path = join(dir, safeFileName(name));
  await writeFile(path, data, { mode: 0o600 });
  return { dir, path };
}

export const removeInlineTemp = (dir: string): Promise<void> =>
  rm(dir, { recursive: true, force: true });
