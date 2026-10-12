import type { IncomingMessage, ServerResponse } from 'node:http';
import { JSONRPCNotificationSchema, ServerNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { isRecord } from '@metro-labs/core/is-record';
import type { MigrationOperation } from './migration-operations.js';

export const isRelaySse = (contentType: string | null | undefined): boolean => /^text\/event-stream\s*(?:;|$)/i.test(contentType ?? '');
const MAX_FRAME = 64 * 1024;
const NOTIFICATIONS = new Set(['notifications/tools/list_changed', 'notifications/resources/list_changed', 'notifications/prompts/list_changed', 'notifications/resources/updated', 'notifications/message']);

export class PassiveSseListener {
  forwarding = false;
  private pending: Buffer[] = [];
  private length = 0;
  private data: string[] = [];
  private fields = false;
  private size = 0;
  private unsafe = false;
  private skipLf = false;
  private first = true;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  idle(): boolean { return !this.unsafe && this.length === 0 && !this.fields && !this.forwarding; }
  keepaliveAllowed(): boolean { return this.unsafe || this.idle(); }

  observe(chunk: Uint8Array): void {
    if (this.unsafe) return;
    this.scan(chunk);
    if (this.unsafe) { this.pending = []; this.length = 0; this.data = []; }
  }

  private append(bytes: Uint8Array): void {
    this.length += bytes.length;
    if (this.length + this.size > MAX_FRAME) this.unsafe = true;
    else if (bytes.length > 0) this.pending.push(Buffer.from(bytes));
  }

  private scan(bytes: Uint8Array): void {
    let start = 0;
    for (let at = 0; at < bytes.length; at += 1) {
      if (at - start + this.length + this.size > MAX_FRAME) { this.unsafe = true; return; }
      const byte = bytes[at];
      if (this.skipLf && byte === 10) { this.skipLf = false; start = at + 1; continue; }
      this.skipLf = false;
      if (byte !== 10 && byte !== 13) continue;
      this.append(bytes.subarray(start, at));
      try { this.line(this.decoder.decode(Buffer.concat(this.pending, this.length)), this.length); }
      catch { this.unsafe = true; }
      this.pending = []; this.length = 0;
      this.skipLf = byte === 13;
      start = at + 1;
      if (this.unsafe) return;
    }
    this.append(bytes.subarray(start));
  }

  private line(raw: string, length: number): void {
    const line = this.first && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    this.first = false;
    if (line === '') {
      if (this.data.length > 0 && !this.notification()) this.unsafe = true;
      this.data = []; this.fields = false; this.size = 0;
      return;
    }
    if (line.startsWith(':')) return;
    this.size += length;
    if (this.size > MAX_FRAME) { this.unsafe = true; return; }
    this.fields = true;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    this.field(field, value);
  }

  private field(field: string, value: string): void {
    if (field === 'data') this.data.push(value);
    else if (field === 'event') { if (value !== '' && value !== 'message') this.unsafe = true; }
    else if (field === 'retry') { if (!/^\d+$/.test(value)) this.unsafe = true; }
    else this.unsafe = true;
  }

  private notification(): boolean {
    const text = this.data.join('\n');
    if (text === '') return true;
    const value: unknown = JSON.parse(text);
    return isRecord(value) && typeof value.method === 'string' && NOTIFICATIONS.has(value.method)
      && JSONRPCNotificationSchema.safeParse(value).success && ServerNotificationSchema.safeParse(value).success;
  }
}

export function passiveRelayListener(req: IncomingMessage, res: ServerResponse, upstream: Response, operation: MigrationOperation, stop: () => void): PassiveSseListener | undefined {
  if (req.method !== 'GET' || req.headers['last-event-id'] !== undefined || req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) !== 0) return undefined;
  if (upstream.status !== 200 || upstream.body === null || !isRelaySse(upstream.headers.get('content-type'))) return undefined;
  const listener = new PassiveSseListener();
  operation.passiveListener({ idle: () => listener.idle() && res.writableLength === 0 && !res.destroyed, stop });
  return listener;
}
