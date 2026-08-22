import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { metroUrl } from './store.js';

const TIMEOUT_MS = 5 * 60_000;
const MAX_BODY = 16 * 1024;

const PAGE = `<!doctype html><meta charset="utf-8"><title>Metro</title>
<body style="font:16px system-ui;padding:3rem;color:#222">
<p id="m">Finishing sign-in…</p>
<script>
const nonce = new URLSearchParams(location.search).get('s') || '';
const body = new URLSearchParams(location.hash.replace(/^#/, ''));
body.set('s', nonce);
fetch('/token', { method: 'POST', body }).then(
  () => { document.getElementById('m').textContent = 'Signed in. You can close this tab.'; },
  () => { document.getElementById('m').textContent = 'Could not reach the metro CLI.'; },
);
</script>`;

function browserCommand(url: string): { cmd: string; args: string[] } {
  if (process.platform === 'darwin') return { cmd: 'open', args: [url] };
  if (process.platform === 'win32')
    return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  return { cmd: 'xdg-open', args: [url] };
}

function openBrowser(url: string): void {
  if (process.env.METRO_NO_BROWSER === '1') return;
  const { cmd, args } = browserCommand(url);
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => undefined);
  child.unref();
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new Error('sign-in body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function sessionFrom(body: string, nonce: string): string {
  const params = new URLSearchParams(body);
  if (params.get('s') !== nonce) return '';
  return params.get('session') ?? '';
}

export function signIn(): Promise<string> {
  const nonce = randomBytes(16).toString('base64url');
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, token?: string): void => {
      if (settled) return;
      settled = true;
      server.close();
      clearTimeout(timer);
      if (err !== null) reject(err);
      else resolve(token ?? '');
    };

    const accept = (res: ServerResponse, body: string): void => {
      const session = sessionFrom(body, nonce);
      if (session === '') {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(204).end();
      finish(null, session);
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST' || !(req.url ?? '').startsWith('/token')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
        return;
      }
      readBody(req).then(
        (body) => {
          accept(res, body);
        },
        () => {
          res.writeHead(400).end();
        },
      );
    });

    const timer = setTimeout(() => {
      finish(new Error('sign-in timed out'));
    }, TIMEOUT_MS);
    timer.unref();

    server.on('error', (err) => {
      finish(err);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const returnTo = `http://127.0.0.1:${String(port)}/callback?s=${nonce}`;
      const url = `${metroUrl()}/auth/google/start?return_to=${encodeURIComponent(returnTo)}`;
      process.stderr.write(`Opening ${url}\n`);
      openBrowser(url);
    });
  });
}
