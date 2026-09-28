import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { kindOf } from '@metro-labs/core/stations/attachments';
import type { OutgoingFile } from '@metro-labs/core/stations/mail';

export interface Draft {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  inReplyTo: string;
  references: string;
  files: OutgoingFile[];
}

const CRLF = '\r\n';

const oneLine = (v: string): string => v.replace(/[\r\n]+/g, ' ').trim();
const isAscii = (v: string): boolean => /^[\x20-\x7e]*$/.test(v);
const WORD_BYTES = 45;
const FOLD = `${CRLF} `;

function utf8Chunks(v: string): string[] {
  const chunks = [''];
  for (const ch of v) {
    const last = chunks.length - 1;
    if (Buffer.byteLength((chunks[last] ?? '') + ch) > WORD_BYTES) chunks.push(ch);
    else chunks[last] = (chunks[last] ?? '') + ch;
  }
  return chunks;
}

const encodedWord = (v: string): string =>
  isAscii(v) ? v : utf8Chunks(v).map((c) => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`).join(FOLD);
const quoted = (v: string): string => `"${v.replace(/["\\]/g, '\\$&')}"`;
const base64Lines = (data: Buffer): string => data.toString('base64').replace(/.{1,76}/g, `$&${CRLF}`);
export const boundaryOf = (): string => `metro_${randomBytes(12).toString('hex')}`;

function fileHeaders(file: OutgoingFile): string[] {
  const name = oneLine(file.name);
  const typeName = isAscii(name) ? quoted(name) : quoted(encodedWord(name));
  const disposition = isAscii(name) ? `filename=${quoted(name)}` : `filename*=UTF-8''${encodeURIComponent(name)}`;
  return [`Content-Type: ${oneLine(file.mime)}; name=${typeName}`, `Content-Disposition: attachment; ${disposition}`, 'Content-Transfer-Encoding: base64'];
}

const part = (headers: string[], body: Buffer): string => [...headers, '', base64Lines(body)].join(CRLF);

export async function buildMime(d: Draft): Promise<{ mime: string; labels: string[] }> {
  const head = [
    `From: ${d.from}`,
    `To: ${d.to.join(`,${FOLD}`)}`,
    ...(d.cc.length > 0 ? [`Cc: ${d.cc.join(`,${FOLD}`)}`] : []),
    `Subject: ${encodedWord(oneLine(d.subject))}`,
    ...(d.inReplyTo === '' ? [] : [`In-Reply-To: ${oneLine(d.inReplyTo)}`]),
    ...(d.references === '' ? [] : [`References: ${oneLine(d.references).split(/\s+/).join(FOLD)}`]),
    'MIME-Version: 1.0',
  ];
  const text = part(['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64'], Buffer.from(d.text, 'utf8'));
  if (d.files.length === 0) return { mime: [...head, text].join(CRLF), labels: [] };
  const boundary = boundaryOf();
  const parts = [text];
  const labels: string[] = [];
  for (const file of d.files) {
    parts.push(part(fileHeaders(file), await readFile(file.path)));
    labels.push(kindOf(file.mime, file.path));
  }
  const body = [...parts.map((p) => `--${boundary}${CRLF}${p}`), `--${boundary}--`, ''];
  return { mime: [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...body].join(CRLF), labels };
}
