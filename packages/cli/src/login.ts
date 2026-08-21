import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { metroUrl } from './store.js';

const TIMEOUT_MS = 5 * 60_000;

const PAGE = `<!doctype html><meta charset="utf-8"><title>Metro</title>
<body style="font:16px system-ui;padding:3rem;color:#222">
<p id="m">Finishing sign-in…</p>
<script>
const hash = location.hash.replace(/^#/, '');
fetch('/token', { method: 'POST', body: hash }).then(
  () => { document.getElementById('m').textContent = 'Signed in. You can close this tab.'; },
  () => { document.getElementById('m').textContent = 'Could not reach the metro CLI.'; },
);
</script>`;

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  const child = spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
  child.on('error', () => undefined);
  child.unref();
}

function sessionFrom(body: string): string {
  const params = new URLSearchParams(body);
  return params.get('session') ?? '';
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function signIn(): Promise<string> {
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

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'POST' && path === '/token') {
        readBody(req)
          .then((body) => {
            res.writeHead(204).end();
            const session = sessionFrom(body);
            if (session === '') finish(new Error('sign-in did not return a session'));
            else finish(null, session);
          })
          .catch(() => {
            res.writeHead(400).end();
          });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
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
      const returnTo = `http://127.0.0.1:${String(port)}/callback`;
      const url = `${metroUrl()}/auth/google/start?return_to=${encodeURIComponent(returnTo)}`;
      process.stderr.write(`Opening ${url}\n`);
      openBrowser(url);
    });
  });
}
