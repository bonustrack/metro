import { afterEach, describe, expect, test } from 'bun:test';
import {
  addAgentConnector,
  mintAgentCode,
  removeAgentConnector,
  setAgentConnectors,
} from '../src/api/agent-connectors';

const AGENTS = 'https://mcp.metro.box/api/agents';
const AGENT = 'agent000001';
const LINEAR = 'conn0000001';
const GITHUB = 'conn0000002';
const NOTION = 'conn0000003';

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

const VIEW = { id: AGENT, name: 'suzy', connectorIds: [LINEAR] };

describe('editing what an agent holds', () => {
  test('adding posts the connector id to the agent, with the session', async () => {
    serve(VIEW);
    const out = await addAgentConnector('session', AGENT, LINEAR);
    expect(calls).toEqual([
      {
        url: `${AGENTS}/${AGENT}/connectors`,
        method: 'POST',
        body: { connectorId: LINEAR },
        authorization: 'Bearer session',
        contentType: 'application/json',
      },
    ]);
    expect(out).toEqual(VIEW);
  });

  test('removing deletes by id and returns what remains', async () => {
    serve({ ...VIEW, connectorIds: [] });
    const out = await removeAgentConnector('session', AGENT, LINEAR);
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe(`${AGENTS}/${AGENT}/connectors/${LINEAR}`);
    expect(calls[0]?.body).toBeUndefined();
    expect(out.connectorIds).toEqual([]);
  });

  test('a selection is applied as a diff: adds what is new, drops what is gone, touches nothing else', async () => {
    serve(VIEW);
    await setAgentConnectors('session', AGENT, [LINEAR, GITHUB], [GITHUB, NOTION]);
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', `${AGENTS}/${AGENT}/connectors`],
      ['DELETE', `${AGENTS}/${AGENT}/connectors/${LINEAR}`],
    ]);
    expect(calls[0]?.body).toEqual({ connectorId: NOTION });
  });

  test('an unchanged selection makes no request at all', async () => {
    serve(VIEW);
    await setAgentConnectors('session', AGENT, [LINEAR], [LINEAR]);
    expect(calls).toEqual([]);
  });

  test('a malformed answer is refused rather than read as an empty agent', async () => {
    serve({ name: 'suzy' });
    await expect(addAgentConnector('session', AGENT, LINEAR)).rejects.toThrow(
      'unexpected response',
    );
  });
});

describe('the pairing code', () => {
  test('it is minted on the agent and names the agent', async () => {
    serve({ code: 'ma_aaaaaaaaaaaaaaaa', expiresAt: 5, agent: 'suzy' }, 201);
    const minted = await mintAgentCode('session', AGENT);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${AGENTS}/${AGENT}/code`);
    expect(minted).toEqual({
      code: 'ma_aaaaaaaaaaaaaaaa',
      expiresAt: 5,
      agent: 'suzy',
    });
  });

  test('a code without an agent name is not a code', async () => {
    serve({ code: 'ma_aaaaaaaaaaaaaaaa' }, 201);
    await expect(mintAgentCode('session', AGENT)).rejects.toThrow(
      'unexpected response',
    );
  });

  test('a refusal carries the daemon message', async () => {
    serve({ error: 'no such agent' }, 404);
    await expect(mintAgentCode('session', AGENT)).rejects.toThrow('no such agent');
  });
});
