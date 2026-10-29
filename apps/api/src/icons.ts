import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConnectorIcon } from '@metro-labs/core/brands';
import { siteDomain } from '@metro-labs/core/favicon';
import { errMsg, log } from '@metro-labs/core/log';
import type { Favicons } from '@metro-labs/connectors/favicons';

const PATH = '/api/icons';
const HOST_RE = /^(?=.{1,253}(:\d{1,5})?$)[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/;
const REVALIDATE = 'no-cache';
const KNOWN_MS = 60_000;
const KNOWN_MAX = 1000;

export interface IconDeps {
  favicons: Favicons;
  declared: (origin: string) => Promise<ConnectorIcon[]>;
  now: () => number;
}

const known = new Map<string, { src: string | null; until: number }>();

function hostOf(url: string): string | null {
  const query = new URLSearchParams(url.split('?')[1] ?? '');
  const host = (query.get('host') ?? query.get('site') ?? '').toLowerCase();
  return HOST_RE.test(host) ? host : null;
}

const darkFirst = (icons: ConnectorIcon[]): string | null => (icons.find((icon) => icon.theme === 'dark') ?? icons.find((icon) => icon.theme === undefined) ?? icons[0])?.src ?? null;

async function iconOf(deps: IconDeps, host: string): Promise<string | null> {
  const held = known.get(host);
  if (held !== undefined && held.until > deps.now()) return held.src;
  const origin = `https://${host}`;
  const src = darkFirst(await deps.declared(origin)) ?? (await deps.favicons.faviconOf(`https://${siteDomain(origin)}`));
  known.delete(host);
  known.set(host, { src, until: deps.now() + KNOWN_MS });
  for (const oldest of known.keys()) {
    if (known.size <= KNOWN_MAX) break;
    known.delete(oldest);
  }
  return src;
}

export function handleIconRequest(req: IncomingMessage, res: ServerResponse, deps: IconDeps): boolean {
  const url = req.url ?? '';
  if (url.split('?')[0] !== PATH) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return true;
  }
  const host = hostOf(url);
  if (host === null) {
    res.writeHead(400).end();
    return true;
  }
  iconOf(deps, host)
    .then((src) => {
      res.writeHead(src === null ? 404 : 302, { 'cache-control': REVALIDATE, ...(src === null ? {} : { location: src }) }).end();
    })
    .catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'api: a site icon failed');
      if (!res.headersSent) res.writeHead(500).end();
    });
  return true;
}
