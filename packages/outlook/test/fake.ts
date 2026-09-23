import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const GRAPH = 'https://graph.test/v1.0';
export const LOGIN = 'https://login.test/common';

export function useFakeMicrosoft(): void {
  process.env.METRO_OUTLOOK_GRAPH_URL = GRAPH;
  process.env.METRO_OUTLOOK_LOGIN_URL = LOGIN;
  process.env.METRO_OUTLOOK_CLIENT_ID = 'test-client';
  process.env.OUTLOOK_STATE_DIR = mkdtempSync(join(tmpdir(), 'outlook-state-'));
  process.env.METRO_XMTP_ATTACH_DIR = mkdtempSync(join(tmpdir(), 'outlook-attach-'));
}

export interface Seen {
  method: string;
  url: string;
  body: string;
  auth: string;
}

export type Route = (req: Seen) => Response | undefined;

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function fakeFetch(routes: Route[]): { fetch: (input: string, init?: RequestInit) => Promise<Response>; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (input: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const req: Seen = {
      method: init.method ?? 'GET',
      url: decodeURIComponent(input),
      body: typeof init.body === 'string' ? init.body : '',
      auth: headers.get('authorization') ?? '',
    };
    seen.push(req);
    for (const route of routes) {
      const res = route(req);
      if (res !== undefined) return Promise.resolve(res);
    }
    return Promise.resolve(json({ error: { code: 'NotFound', message: `no fake for ${req.method} ${req.url}` } }, 404));
  };
  return { fetch: fetchImpl, seen };
}

export const tokenRoute = (access = 'at-2', refresh = 'rt-2'): Route => (req) =>
  req.url.startsWith(`${LOGIN}/oauth2/v2.0/token`) && req.body.includes('grant_type=refresh_token')
    ? json({ access_token: access, refresh_token: refresh, expires_in: 3600 })
    : undefined;

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
