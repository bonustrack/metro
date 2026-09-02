export interface EventStreamMessage {
  headers: Record<string, string>;
  payload: Buffer;
}

const PRELUDE_BYTES = 12;
const CRC_BYTES = 4;

const HEADER_TRUE = 0;
const HEADER_FALSE = 1;
const HEADER_BYTE = 2;
const HEADER_SHORT = 3;
const HEADER_INT = 4;
const HEADER_LONG = 5;
const HEADER_BYTES = 6;
const HEADER_STRING = 7;
const HEADER_TIMESTAMP = 8;
const HEADER_UUID = 9;

const FIXED_WIDTH: Record<number, number> = {
  [HEADER_TRUE]: 0,
  [HEADER_FALSE]: 0,
  [HEADER_BYTE]: 1,
  [HEADER_SHORT]: 2,
  [HEADER_INT]: 4,
  [HEADER_LONG]: 8,
  [HEADER_TIMESTAMP]: 8,
  [HEADER_UUID]: 16,
};

function readHeaderValue(
  buf: Buffer,
  at: number,
  type: number,
): { value: string; next: number } {
  if (type === HEADER_BYTES || type === HEADER_STRING) {
    const len = buf.readUInt16BE(at);
    const raw = buf.subarray(at + 2, at + 2 + len);
    const value =
      type === HEADER_STRING ? raw.toString('utf8') : raw.toString('base64');
    return { value, next: at + 2 + len };
  }
  const width = FIXED_WIDTH[type];
  if (width === undefined) throw new Error(`eventstream: unknown header type ${String(type)}`);
  if (type === HEADER_TRUE) return { value: 'true', next: at };
  if (type === HEADER_FALSE) return { value: 'false', next: at };
  return { value: buf.subarray(at, at + width).toString('hex'), next: at + width };
}

function readHeaders(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < buf.length) {
    const nameLen = buf.readUInt8(at);
    const name = buf.subarray(at + 1, at + 1 + nameLen).toString('utf8');
    const type = buf.readUInt8(at + 1 + nameLen);
    const parsed = readHeaderValue(buf, at + 2 + nameLen, type);
    out[name] = parsed.value;
    at = parsed.next;
  }
  return out;
}

export function decodeFrame(
  buf: Buffer,
  offset: number,
): { message: EventStreamMessage; end: number } | null {
  if (buf.length - offset < PRELUDE_BYTES) return null;
  const total = buf.readUInt32BE(offset);
  const headersLen = buf.readUInt32BE(offset + 4);
  if (total < PRELUDE_BYTES + CRC_BYTES || headersLen > total)
    throw new Error('eventstream: malformed frame prelude');
  if (buf.length - offset < total) return null;
  const headersStart = offset + PRELUDE_BYTES;
  const payloadStart = headersStart + headersLen;
  const payloadEnd = offset + total - CRC_BYTES;
  return {
    message: {
      headers: readHeaders(buf.subarray(headersStart, payloadStart)),
      payload: Buffer.from(buf.subarray(payloadStart, payloadEnd)),
    },
    end: offset + total,
  };
}

export class EventStreamDecoder {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): EventStreamMessage[] {
    this.pending =
      this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const out: EventStreamMessage[] = [];
    let offset = 0;
    for (;;) {
      const frame = decodeFrame(this.pending, offset);
      if (frame === null) break;
      out.push(frame.message);
      offset = frame.end;
    }
    this.pending = this.pending.subarray(offset);
    return out;
  }

  leftover(): number {
    return this.pending.length;
  }
}

function encodeHeader(name: string, value: string): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const valueBuf = Buffer.from(value, 'utf8');
  const out = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valueBuf.length);
  let at = 0;
  out.writeUInt8(nameBuf.length, at);
  at += 1;
  nameBuf.copy(out, at);
  at += nameBuf.length;
  out.writeUInt8(HEADER_STRING, at);
  at += 1;
  out.writeUInt16BE(valueBuf.length, at);
  at += 2;
  valueBuf.copy(out, at);
  return out;
}

export function encodeFrame(
  headers: Record<string, string>,
  payload: Buffer,
): Buffer {
  const headerBuf = Buffer.concat(
    Object.entries(headers).map(([name, value]) => encodeHeader(name, value)),
  );
  const total = PRELUDE_BYTES + headerBuf.length + payload.length + CRC_BYTES;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(total, 0);
  out.writeUInt32BE(headerBuf.length, 4);
  out.writeUInt32BE(0, 8);
  headerBuf.copy(out, PRELUDE_BYTES);
  payload.copy(out, PRELUDE_BYTES + headerBuf.length);
  out.writeUInt32BE(0, total - CRC_BYTES);
  return out;
}
