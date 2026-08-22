import { afterEach, describe, expect, test } from 'bun:test';
import { AuthError } from '../src/api/client';
import {
  connectorHost,
  connectorsInOrder,
  createConnector,
  deleteConnector,
  fetchConnectors,
  serverLabel,
  verifyConnector,
  type Connector,
} from '../src/api/connectors';

const CONNECTORS = 'https://mcp.metro.box/api/connectors';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Seen {
  url: string;
  method: string | undefined;
  body: unknown;
  authorization: unknown;
  contentType: unknown;
}

let calls: Seen[] = [];

function serve(body: unknown, status = 200): void {
  calls = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const headers: Record<string, unknown> = { ...init?.headers };
    calls.push({
      url,
      method: init?.method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      authorization: headers.authorization,
      contentType: headers['content-type'],
    });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
}

const VERIFIED = {
  at: '2026-08-21T09:14:04.880Z',
  server: 'linear',
  version: '1.4.0',
  protocol: '2025-06-18',
  icon: '',
  tools: 12,
  catalog: [],
};

const ROW = {
  id: 'id000000012',
  name: 'linear',
  exportName: 'metro.box linear',
  url: 'https://mcp.linear.app/mcp',
  transport: 'http',
  auth: 'header',
  header: 'Authorization',
  secret: 'Bearer lin_oauth_7f',
  json: '{\n  "mcpServers": {}\n}',
  verified: VERIFIED,
};

const NEW = {
  name: 'linear',
  url: 'https://mcp.linear.app/mcp',
  header: '',
  value: '',
};

const list = async (body: unknown): Promise<Connector[]> => {
  serve(body);
  return (await fetchConnectors('session')).connectors;
};

describe('the connectors surface is its own endpoint', () => {
  test('a list reads /api/connectors, never a path under /api/agents', async () => {
    serve({ connectors: [], json: '{}' });
    await fetchConnectors('session');
    expect(calls[0]?.url).toBe(CONNECTORS);
    expect(calls[0]?.url).not.toContain('/api/agents');
    expect(calls[0]?.method).toBe('GET');
  });

  test('a create posts the collection itself', async () => {
    serve(ROW, 201);
    await createConnector('session', NEW);
    expect(calls).toEqual([
      {
        url: CONNECTORS,
        method: 'POST',
        body: { name: 'linear', url: 'https://mcp.linear.app/mcp', returnTo: '' },
        authorization: 'Bearer session',
        contentType: 'application/json',
      },
    ]);
  });

  test('a verify posts the id sub-resource', async () => {
    serve({ id: 'id000000012', name: 'linear', ok: true, verified: VERIFIED });
    await verifyConnector('session', 12);
    expect(calls[0]?.url).toBe(`${CONNECTORS}/12/verify`);
    expect(calls[0]?.method).toBe('POST');
  });

  test('a delete addresses the row by id', async () => {
    serve({ id: 'id000000012', name: 'linear', deleted: true });
    await deleteConnector('session', 12);
    expect(calls[0]?.url).toBe(`${CONNECTORS}/12`);
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.authorization).toBe('Bearer session');
  });
});

describe('the create body carries only what was filled in', () => {
  test('an auth pair is sent as header and value', async () => {
    serve(ROW, 201);
    await createConnector('session', {
      ...NEW,
      header: 'Authorization',
      value: 'Bearer lin_oauth_7f',
    });
    expect(calls[0]?.body).toEqual({
      name: 'linear',
      url: 'https://mcp.linear.app/mcp',
      header: 'Authorization',
      value: 'Bearer lin_oauth_7f',
      returnTo: '',
    });
  });

  test('a value with no header leaves the header to the daemon default', async () => {
    serve(ROW, 201);
    await createConnector('session', { ...NEW, value: 'Bearer lin_oauth_7f' });
    expect(calls[0]?.body).toEqual({
      name: 'linear',
      url: 'https://mcp.linear.app/mcp',
      value: 'Bearer lin_oauth_7f',
      returnTo: '',
    });
  });

  test('an empty pair sends neither field rather than two empty strings', async () => {
    serve(ROW, 201);
    await createConnector('session', NEW);
    expect(calls[0]?.body).toEqual({
      name: 'linear',
      url: 'https://mcp.linear.app/mcp',
      returnTo: '',
    });
  });
});

describe('a connector row is coerced field by field', () => {
  test('a well-formed row survives the wire unchanged', async () => {
    expect(await list({ connectors: [ROW], json: '{}' })).toEqual([
      {
        id: 'id000000012',
        name: 'linear',
        exportName: 'metro.box linear',
        url: 'https://mcp.linear.app/mcp',
        transport: 'http',
        auth: 'header',
        header: 'Authorization',
        signIn: null,
        verified: VERIFIED,
      },
    ]);
  });

  test('a no-auth row reports no header', async () => {
    const [row] = await list({
      connectors: [
        { ...ROW, auth: 'none', header: null, secret: null },
      ],
      json: '{}',
    });
    expect([row?.auth, row?.header]).toEqual(['none', null]);
  });

  test('an auth value the daemon never sends reads as no auth, never as header', async () => {
    const [row] = await list({
      connectors: [{ ...ROW, auth: 'basic' }],
      json: '{}',
    });
    expect(row?.auth).toBe('none');
  });

  test('oauth is a real auth kind now, and survives the wire', async () => {
    const [row] = await list({
      connectors: [{ ...ROW, auth: 'oauth', header: null, secret: null }],
      json: '{}',
    });
    expect(row?.auth).toBe('oauth');
    expect(row?.auth).toBe('oauth');
  });

  test('the tool catalog is coerced entry by entry, junk dropped', async () => {
    const [row] = await list({
      connectors: [
        {
          ...ROW,
          verified: {
            ...VERIFIED,
            catalog: [
              { name: 'a', kind: 'read' },
              { name: 'b', kind: 'not-a-kind' },
              { description: 'nameless' },
              null,
            ],
          },
        },
      ],
      json: '{}',
    });
    expect(row?.verified?.catalog.map((t) => [t.name, t.kind])).toEqual([
      ['a', 'read'],
      ['b', 'write'],
    ]);
  });

  test('missing and mistyped fields fall back instead of reaching the page', async () => {
    const [row] = await list({
      connectors: [{ name: 'bare', id: 7, url: 7, secret: 3, verified: 'yes' }],
      json: 5,
    });
    expect(row).toEqual({
      id: '',
      name: 'bare',
      exportName: 'bare',
      url: '',
      transport: '',
      auth: 'none',
      header: null,
      signIn: null,
      verified: null,
    });
  });

  test('a verified block with a mistyped tool count reads as zero, not NaN', async () => {
    const [row] = await list({
      connectors: [{ ...ROW, verified: { ...VERIFIED, tools: '12', server: 9 } }],
      json: '{}',
    });
    expect(row?.verified).toEqual({
      at: '2026-08-21T09:14:04.880Z',
      server: '',
      version: '1.4.0',
      protocol: '2025-06-18',
      icon: '',
      tools: 0,
      catalog: [],
    });
  });

  test('a row with no name is refused rather than rendered as blank', async () => {
    serve({ connectors: [{ id: 'id000000012' }], json: '{}' });
    await expect(fetchConnectors('session')).rejects.toThrow('unexpected');
  });

  test('a body that is not an object is refused', async () => {
    serve([ROW]);
    await expect(fetchConnectors('session')).rejects.toThrow('unexpected');
  });

  test('a body with no connectors array lists nothing rather than throwing', async () => {
    expect(await list({ json: '{}' })).toEqual([]);
    expect(await list({ connectors: 'none', json: '{}' })).toEqual([]);
  });

  test('a create answers with the same shape a list row has', async () => {
    serve(ROW, 201);
    const result = await createConnector('session', NEW);
    if (result.kind !== 'added') throw new Error('expected an added connector');
    expect(result.connector.id).toBe('id000000012');
    expect(result.connector.name).toBe('linear');
    expect(result.connector.verified?.tools).toBe(12);
  });

  test('a 202 oauth answer is a sign-in to follow, not a connector', async () => {
    serve({ status: 'oauth', authorizeUrl: 'https://as.example.com/authorize?x=1' }, 202);
    const result = await createConnector('session', NEW);
    expect(result).toEqual({
      kind: 'oauth',
      authorizeUrl: 'https://as.example.com/authorize?x=1',
    });
  });

  test('an oauth answer missing its url is not mistaken for one', async () => {
    serve({ status: 'oauth' }, 202);
    await expect(createConnector('session', NEW)).rejects.toThrow('unexpected');
  });

  test('a create answering with no name is refused', async () => {
    serve({ id: 'id000000012' }, 201);
    await expect(createConnector('session', NEW)).rejects.toThrow('unexpected');
  });
});

describe('a re-verify reports its own verdict', () => {
  test('a passing check carries the fresh verified block', async () => {
    serve({ id: 'id000000012', name: 'linear', ok: true, verified: VERIFIED });
    expect(await verifyConnector('session', 12)).toEqual({
      id: 'id000000012',
      name: 'linear',
      ok: true,
      verified: VERIFIED,
      reason: null,
    });
  });

  test('a failing check carries the reason and no verified block', async () => {
    serve({
      id: 'id000000012',
      name: 'linear',
      ok: false,
      reason: 'mcp.linear.app rejected that credential.',
    });
    expect(await verifyConnector('session', 12)).toEqual({
      id: 'id000000012',
      name: 'linear',
      ok: false,
      verified: null,
      reason: 'mcp.linear.app rejected that credential.',
    });
  });

  test('anything other than a literal true is not a pass', async () => {
    serve({ id: 'id000000012', name: 'linear', ok: 'true' });
    expect((await verifyConnector('session', 12)).ok).toBe(false);
  });

  test('a response with no id falls back to the id that was asked about', async () => {
    serve({ name: 'linear', ok: true, verified: VERIFIED });
    expect((await verifyConnector('session', 12)).id).toBe(12);
  });

  test('a body that is not an object is refused', async () => {
    serve('ok');
    await expect(verifyConnector('session', 12)).rejects.toThrow('unexpected');
  });
});

describe('daemon refusals reach the page as themselves', () => {
  test('a 404 surfaces the daemon own wording', async () => {
    serve({ error: 'no such connector' }, 404);
    await expect(deleteConnector('session', 99)).rejects.toThrow(
      'no such connector',
    );
  });

  test('a remote refusal arrives as a 400, and stays a plain error', async () => {
    serve({ error: 'mcp.linear.app rejected that credential.' }, 400);
    await expect(createConnector('session', NEW)).rejects.toThrow(
      'rejected that credential',
    );
    serve({ error: 'mcp.linear.app rejected that credential.' }, 400);
    await expect(createConnector('session', NEW)).rejects.not.toBeInstanceOf(
      AuthError,
    );
  });

  test('an expired metro session is an AuthError, not a message', async () => {
    serve({ error: 'not authorized' }, 401);
    await expect(fetchConnectors('session')).rejects.toBeInstanceOf(AuthError);
  });
});

describe('the row labels are derived, never asserted', () => {
  test('the host is read off the url and never shows the credential', () => {
    expect(connectorHost('https://mcp.linear.app/mcp')).toBe('mcp.linear.app');
    expect(connectorHost('https://mcp.linear.app:8443/mcp')).toBe(
      'mcp.linear.app:8443',
    );
  });

  test('a url that will not parse is shown as it came', () => {
    expect(connectorHost('not a url')).toBe('not a url');
    expect(connectorHost('')).toBe('');
  });

  test('the server label pairs name and version, and drops what is missing', () => {
    expect(serverLabel(VERIFIED)).toBe('linear 1.4.0');
    expect(serverLabel({ ...VERIFIED, version: '' })).toBe('linear');
    expect(serverLabel({ ...VERIFIED, server: '' })).toBe('1.4.0');
    expect(serverLabel({ ...VERIFIED, server: '', version: '' })).toBe('-');
  });
});

describe('connectors that need signing in sink to the bottom', () => {
  const row = (id: string, signIn: Connector['signIn']): Connector =>
    ({ id, signIn }) as Connector;

  test('disconnected rows come last', () => {
    const order = connectorsInOrder([
      row('a', 'disconnected'),
      row('b', 'connected'),
      row('c', null),
      row('d', 'disconnected'),
    ]).map((c) => c.id);
    expect(order).toEqual(['b', 'c', 'a', 'd']);
  });

  test('it is stable, so equal rows keep the order metro sent', () => {
    const order = connectorsInOrder([
      row('a', 'connected'),
      row('b', null),
      row('c', 'connected'),
    ]).map((c) => c.id);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('it returns a new array rather than sorting the query cache in place', () => {
    const input = [row('a', 'disconnected'), row('b', 'connected')];
    expect(connectorsInOrder(input)).not.toBe(input);
    expect(input.map((c) => c.id)).toEqual(['a', 'b']);
  });
});
