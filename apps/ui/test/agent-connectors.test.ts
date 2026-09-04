import { afterEach, describe, expect, test } from 'bun:test';
import { mintAgentCode } from '../src/api/agent-connectors';

const AGENTS = 'https://mcp.metro.box/api/agents';
const AGENT = 'agent000001';

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
