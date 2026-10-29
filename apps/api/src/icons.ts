import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import type { Favicons } from '@metro-labs/connectors/favicons';

const PATH = '/api/icons';
const SITE_RE = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const REVALIDATE = 'no-cache';

function siteOf(url: string): string | null {
  const site = (new URLSearchParams(url.split('?')[1] ?? '').get('site') ?? '').toLowerCase();
  return SITE_RE.test(site) ? site : null;
}

export function handleIconRequest(req: IncomingMessage, res: ServerResponse, favicons: Favicons): boolean {
  const url = req.url ?? '';
  if (url.split('?')[0] !== PATH) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return true;
  }
  const site = siteOf(url);
  if (site === null) {
    res.writeHead(400).end();
    return true;
  }
  favicons
    .faviconOf(`https://${site}`)
    .then((src) => {
      res.writeHead(src === null ? 404 : 302, { 'cache-control': REVALIDATE, ...(src === null ? {} : { location: src }) }).end();
    })
    .catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'api: a site icon failed');
      if (!res.headersSent) res.writeHead(500).end();
    });
  return true;
}
