/**
 * Subprocess harness for monitor tests: imports `handleMonitorRequest` from
 * `src/monitor-api.ts`, mounts it on an ephemeral 127.0.0.1 port, then prints the
 * port number on stdout and waits forever.
 *
 * Since history.jsonl was removed, events now live only in the in-process bus.
 * This harness exposes a test-only `POST /seed` that publishes events into that
 * same bus, so the monitor's `/api/state` ring buffer and `/api/tail` SSE see
 * them exactly as a real daemon's `emit()` would feed them.
 *
 * Run via `bun monitor-harness.mjs` so the TypeScript import works without compilation.
 */

import { createServer } from 'node:http';
import { handleMonitorRequest } from '../src/monitor-api.ts';
import { publishEvent } from '../src/event-bus.ts';

function readJsonBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(buf)); } catch { resolve(undefined); }
    });
  });
}

const server = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (req.method === 'POST' && path === '/seed') {
    readJsonBody(req).then((events) => {
      for (const e of Array.isArray(events) ? events : []) publishEvent(e);
      res.writeHead(200).end('ok');
    });
    return;
  }
  if (!handleMonitorRequest(req, res)) {
    res.writeHead(404).end();
  }
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    process.stderr.write('no address\n');
    process.exit(1);
  }
  /** First line of stdout = port. The test harness reads this. */
  process.stdout.write(`${addr.port}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
