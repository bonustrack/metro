import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { allowLocalConnectors } from '../src/connectors/url.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ConnectorVerifyError,
  parseConnectorUrl,
  verifyRemoteMcp,
  type ConnectorAuth,
} from '../src/connectors/verify.ts';

const POLICY_MESSAGE =
  'Metro connects from its own server, so it cannot reach a URL on your machine. localhost and private addresses are not usable as connectors.';

const NONE: ConnectorAuth = { kind: 'none' };
const BEARER: ConnectorAuth = {
  kind: 'header',
  name: 'Authorization',
  value: 'Bearer lin_oauth_7f',
};

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = (req: IncomingMessage, res: ServerResponse, body: unknown) => void;

let server: Server;
let origin: string;
let deadPort: number;
let seen: Seen[] = [];
let reply: Reply;

const rpcMethod = (body: unknown): string =>
  typeof body === 'object' && body !== null
    ? String((body as Record<string, unknown>).method ?? '')
    : '';

const initResult = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: {} },
  serverInfo: { name: 'linear', version: '1.4.0' },
};

const asJson = (res: ServerResponse, payload: unknown, id: number): void => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result: payload }));
};

const asSse = (res: ServerResponse, payload: unknown, id: number): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  res.end(
    `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: payload })}\n\n`,
  );
};

function speakMcp(
  res: ServerResponse,
  body: unknown,
  frame: (r: ServerResponse, payload: unknown, id: number) => void,
  session: string | null,
): void {
  if (rpcMethod(body) !== 'initialize') {
    res.writeHead(405).end();
    return;
  }
  if (session !== null) res.setHeader('mcp-session-id', session);
  frame(res, initResult, 1);
}

const sseServer =
  (session: string | null = 'sess-abc'): Reply =>
  (_req, res, body) => {
    speakMcp(res, body, asSse, session);
  };

const jsonServer =
  (session: string | null = 'sess-abc'): Reply =>
  (_req, res, body) => {
    speakMcp(res, body, asJson, session);
  };

const probe = (path = '/mcp', auth: ConnectorAuth = NONE): Promise<unknown> =>
  verifyRemoteMcp(new URL(`${origin}${path}`), auth);

async function refusal(run: Promise<unknown>): Promise<ConnectorVerifyError> {
  try {
    await run;
  } catch (err) {
    if (err instanceof ConnectorVerifyError) return err;
    throw err;
  }
  throw new Error('the probe was expected to refuse, and did not');
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = raw === '' ? null : JSON.parse(raw);
      } catch {
        body = raw;
      }
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers as unknown as Record<string, string>,
        body,
      });
      reply(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const doomed = createServer(() => undefined);
  await new Promise<void>((r) => doomed.listen(0, '127.0.0.1', () => r()));
  deadPort = (doomed.address() as AddressInfo).port;
  await new Promise<void>((r) => doomed.close(() => r()));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  seen = [];
  reply = sseServer();
});

beforeAll(() => {
  allowLocalConnectors(false);
});

describe('parseConnectorUrl is the security boundary', () => {
  test('an ordinary https url passes through', () => {
    const url = parseConnectorUrl('  https://mcp.linear.app/mcp  ');
    expect(url.toString()).toBe('https://mcp.linear.app/mcp');
  });

  test('a query string survives — it is often the credential', () => {
    expect(parseConnectorUrl('https://mcp.example.com/mcp?tenant=7').search).toBe(
      '?tenant=7',
    );
  });

  const policy = [
    'https://localhost/mcp',
    'https://LOCALHOST/mcp',
    'https://foo.localhost/mcp',
    'https://box.local/mcp',
    'https://svc.internal/mcp',
    'https://127.0.0.1/mcp',
    'https://10.0.0.7/mcp',
    'https://192.168.1.5/mcp',
    'https://[::1]/mcp',
    'https://[fd00::1]/mcp',
    'https://intranet/mcp',
    'https://metro.flycast/mcp',
    'https://top1.nearest.of.metro.internal/mcp',
  ];

  for (const raw of policy)
    test(`${raw} is refused with the one policy sentence`, () => {
      let caught: unknown;
      try {
        parseConnectorUrl(raw);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConnectorVerifyError);
      expect((caught as ConnectorVerifyError).message).toBe(POLICY_MESSAGE);
      expect((caught as ConnectorVerifyError).status).toBe(400);
    });

  const malformed: [string, RegExp][] = [
    ['http://mcp.linear.app/mcp', /must start with https/],
    ['ws://mcp.linear.app/mcp', /must start with https/],
    ['https://user:pass@mcp.linear.app/mcp', /user:password/],
    ['https://user@mcp.linear.app/mcp', /user:password/],
    ['https://mcp.linear.app/mcp#tools', /#fragment/],
    ['not a url at all', /not a valid url/],
    ['', /url is required/],
    ['   ', /url is required/],
  ];

  for (const [raw, pattern] of malformed)
    test(`${raw || '(empty)'} is refused, separately worded`, () => {
      let caught: unknown;
      try {
        parseConnectorUrl(raw);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConnectorVerifyError);
      expect((caught as ConnectorVerifyError).message).toMatch(pattern);
      expect((caught as ConnectorVerifyError).status).toBe(400);
    });

  test('a non-string is refused rather than coerced', () => {
    for (const raw of [undefined, null, 42, {}, ['https://mcp.linear.app/mcp']])
      expect(() => parseConnectorUrl(raw)).toThrow(ConnectorVerifyError);
  });

  test('the loopback fixture this file talks to is itself refused', () => {
    expect(() => parseConnectorUrl(origin)).toThrow(ConnectorVerifyError);
  });
});

describe('verifyRemoteMcp is one initialize, over SSE or plain JSON', () => {
  test('the happy path reports the server name from the SSE answer', async () => {
    expect(await probe()).toEqual({ server: 'linear' });
  });

  test('initialize offers both media types and asks for the latest protocol', async () => {
    await probe();
    const init = seen[0];
    expect(init?.method).toBe('POST');
    expect(init?.headers.accept).toBe('application/json, text/event-stream');
    expect(init?.headers['content-type']).toBe('application/json');
    expect(init?.body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', clientInfo: { name: 'metro', version: '0.1.0' } },
    });
  });

  test('exactly one frame is sent, and no session is opened or ended', async () => {
    await probe();
    expect(seen.map((s) => `${s.method} ${rpcMethod(s.body)}`)).toEqual(['POST initialize']);
  });

  test('a stateless server that sends no mcp-session-id verifies the same', async () => {
    reply = sseServer(null);
    expect(await probe()).toEqual({ server: 'linear' });
  });

  test('a keepalive comment, a retry directive, an id line and CRLF endings are all skipped', async () => {
    const answer = JSON.stringify({ jsonrpc: '2.0', id: 1, result: initResult });
    reply = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`: keep-alive\r\n\r\nretry: 3000\r\n\r\nid: 7\r\nevent: message\r\ndata: ${answer}\r\n\r\n`);
    };
    expect(await probe()).toEqual({ server: 'linear' });
  });

  test('the auth header rides on the frame', async () => {
    await probe('/mcp', BEARER);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.authorization).toBe('Bearer lin_oauth_7f');
  });

  test('a plain JSON answer is read the same way, and a title beats a name', async () => {
    reply = (_req, res) => {
      asJson(res, { ...initResult, serverInfo: { name: 'linear', title: 'Linear' } }, 1);
    };
    expect(await probe()).toEqual({ server: 'Linear' });
    reply = jsonServer();
    expect(await probe()).toEqual({ server: 'linear' });
  });

  test('a server with no serverInfo is named after its host', async () => {
    reply = (_req, res) => {
      asJson(res, { protocolVersion: '2025-06-18' }, 1);
    };
    expect(await probe()).toEqual({ server: '127.0.0.1' });
  });
});

describe('the three failures are worded separately', () => {
  test('a remote 401 is a rejected credential, never metro saying unauthorized', async () => {
    reply = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_token"}');
    };
    const err = await refusal(probe('/mcp', BEARER));
    expect(err.message).toBe('127.0.0.1 rejected that credential.');
    expect(err.status).toBe(400);
  });

  test('a remote 403 with a credential is worded the same way', async () => {
    reply = (_req, res) => {
      res.writeHead(403).end('forbidden');
    };
    expect((await refusal(probe('/mcp', BEARER))).message).toBe(
      '127.0.0.1 rejected that credential.',
    );
  });

  test('a 401 with NO credential says authorization is required, not rejected', async () => {
    reply = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_token"}');
    };
    const err = await refusal(probe());
    expect(err.message).toBe('127.0.0.1 requires authorization.');
    expect(err.message).not.toContain('rejected');
    expect(err.status).toBe(400);
  });

  test('an HTML page is answered-but-not-MCP', async () => {
    reply = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Linear</title>');
    };
    expect((await refusal(probe())).message).toBe(
      '127.0.0.1 answered, but it does not speak MCP.',
    );
  });

  test('a JSON-RPC error object is answered-but-not-MCP', async () => {
    reply = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"no"}}');
    };
    expect((await refusal(probe())).message).toBe(
      '127.0.0.1 answered, but it does not speak MCP.',
    );
  });

  test('a 200 with no protocolVersion is answered-but-not-MCP', async () => {
    reply = (_req, res) => {
      asJson(res, { serverInfo: { name: 'linear' } }, 1);
    };
    expect((await refusal(probe())).message).toBe(
      '127.0.0.1 answered, but it does not speak MCP.',
    );
  });

  test('an empty SSE stream is answered-but-not-MCP', async () => {
    reply = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(': keepalive\n\n');
    };
    expect((await refusal(probe())).message).toBe(
      '127.0.0.1 answered, but it does not speak MCP.',
    );
  });

  test('a 500 names the status, not a credential problem', async () => {
    reply = (_req, res) => {
      res.writeHead(500).end('boom');
    };
    expect((await refusal(probe())).message).toBe('127.0.0.1 answered 500 instead of an MCP initialize.');
  });

  for (const status of [404, 405])
    test(`a ${status} on the POST names the legacy-SSE limit`, async () => {
      reply = (_req, res) => {
        res.writeHead(status).end();
      };
      const err = await refusal(probe());
      expect(err.message).toBe(
        '127.0.0.1 did not accept an MCP initialize over HTTP POST. ' +
          'If it is a legacy SSE server, Metro cannot verify it yet.',
      );
      expect(err.status).toBe(400);
    });

  test('a refused connection is unreachable, not rejected', async () => {
    const err = await refusal(
      verifyRemoteMcp(new URL(`http://127.0.0.1:${deadPort}/mcp`), NONE),
    );
    expect(err.message).toMatch(/^Metro could not reach 127\.0\.0\.1: .*\(nothing is listening there\)$/);
    expect(err.status).toBe(400);
  });
});

describe('a redirect is refused, never followed', () => {
  for (const status of [301, 302, 307, 308])
    test(`a ${status} tells the caller to use the target url`, async () => {
      reply = (_req, res) => {
        res.writeHead(status, { location: 'https://elsewhere.example/mcp' });
        res.end();
      };
      const err = await refusal(probe());
      expect(err.message).toBe('that url redirects — use the url it redirects to');
      expect(err.status).toBe(400);
      expect(seen).toHaveLength(1);
    });

  test('the credential is not replayed to the redirect target', async () => {
    reply = (_req, res) => {
      res.writeHead(302, { location: 'https://elsewhere.example/mcp' });
      res.end();
    };
    await refusal(probe('/mcp', BEARER));
    expect(seen.map((s) => s.url)).toEqual(['/mcp']);
  });
});
