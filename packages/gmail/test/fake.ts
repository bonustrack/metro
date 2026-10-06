import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const API = 'https://gmail.test';
export const TOKEN = 'https://oauth2.test/token';
export const USER = `${API}/gmail/v1/users/me`;

export function useFakeGoogle(): void {
  process.env.METRO_GMAIL_API_URL = API;
  process.env.METRO_GMAIL_TOKEN_URL = TOKEN;
  process.env.GMAIL_STATE_DIR = mkdtempSync(join(tmpdir(), 'gmail-state-'));
  process.env.METRO_XMTP_ATTACH_DIR = mkdtempSync(join(tmpdir(), 'gmail-attach-'));
}

export interface Seen {
  method: string;
  url: string;
  body: string;
  auth: string;
  type: string;
}

export type Route = (req: Seen) => Response | undefined | Promise<Response | undefined>;

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function fakeFetch(routes: Route[]): { fetch: (input: string, init?: RequestInit) => Promise<Response>; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const req: Seen = {
      method: init.method ?? 'GET',
      url: decodeURIComponent(input.replace(/\+/g, ' ')),
      body: typeof init.body === 'string' ? init.body : '',
      auth: headers.get('authorization') ?? '',
      type: headers.get('content-type') ?? '',
    };
    seen.push(req);
    for (const route of routes) {
      const res = await route(req);
      if (res !== undefined) return Promise.resolve(res);
    }
    return Promise.resolve(json({ error: { status: 'NOT_FOUND', message: `no fake for ${req.method} ${req.url}` } }, 404));
  };
  return { fetch: fetchImpl, seen };
}

export interface Written {
  responses: Record<string, unknown>[];
  events: Record<string, unknown>[];
}

export function capture(): { written: Written; restore: () => void } {
  const written: Written = { responses: [], events: [] };
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.op === 'response') written.responses.push(parsed);
      else if (parsed.op !== 'log') written.events.push(parsed);
    }
    return true;
  }) as typeof process.stdout.write;
  return {
    written,
    restore: () => {
      process.stdout.write = orig;
    },
  };
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

export interface MessageOpts {
  threadId?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  labels?: string[];
  auth?: string;
  headers?: { name: string; value: string }[];
  text?: string;
  html?: string;
  files?: { name: string; mime: string; data?: string; attachmentId?: string; size: number }[];
  at?: number;
}

export function message(id: string, o: MessageOpts = {}): Record<string, unknown> {
  const headers = [
    ...(o.auth === undefined ? [] : [{ name: 'Authentication-Results', value: o.auth }]),
    { name: 'From', value: o.from ?? '"Bea Muster" <Bea@Example.ch>' },
    { name: 'To', value: o.to ?? 'admin@snapshot.org' },
    ...(o.cc === undefined ? [] : [{ name: 'Cc', value: o.cc }]),
    { name: 'Subject', value: o.subject ?? 'Invoice' },
    { name: 'Message-ID', value: `<${id}@example.ch>` },
    ...(o.headers ?? []),
  ];
  const body = o.html === undefined ? { mimeType: 'text/plain', body: { data: b64(o.text ?? 'Hello Admin,\r\n\r\nsee attached') } } : { mimeType: 'text/html', body: { data: b64(o.html) } };
  const files = (o.files ?? []).map((f) => ({ mimeType: f.mime, filename: f.name, body: { size: f.size, ...(f.data === undefined ? {} : { data: b64(f.data) }), ...(f.attachmentId === undefined ? {} : { attachmentId: f.attachmentId }) } }));
  return {
    id,
    threadId: o.threadId ?? 'thread-1',
    labelIds: o.labels ?? ['INBOX', 'UNREAD'],
    snippet: 'Hello Admin, see &quot;attached&quot;',
    internalDate: String(o.at ?? Date.parse('2026-09-28T10:00:00Z')),
    payload: { mimeType: files.length > 0 ? 'multipart/mixed' : body.mimeType, headers, ...(files.length > 0 ? { parts: [body, ...files] } : body) },
  };
}
