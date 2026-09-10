import type { IncomingMessage } from 'node:http';

export const WEBHOOK_BODY_MAX = 25 * 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
  }
}

export async function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
