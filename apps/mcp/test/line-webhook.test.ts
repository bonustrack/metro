import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'sekret';
const dir = mkdtempSync(join(tmpdir(), 'line-wh-'));
const accountsFile = join(dir, 'line-accounts.json');
process.env.LINE_ACCOUNTS_FILE = accountsFile;
writeFileSync(
  accountsFile,
  JSON.stringify([
    { id: 'l0', channelAccessToken: 'tok', channelSecret: SECRET },
  ]),
);

const { handleLineWebhook, isLineWebhookPath } = await import(
  '../src/daemon/line-webhook.js'
);

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(Buffer.from(body)).digest('base64');
}

function req(opts: {
  method: string;
  url: string;
  body?: string;
  sig?: string;
}): import('node:http').IncomingMessage {
  const headers: Record<string, string> = {};
  if (opts.sig !== undefined) headers['x-line-signature'] = opts.sig;
  const body = opts.body ?? '';
  return {
    method: opts.method,
    url: opts.url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  } as unknown as import('node:http').IncomingMessage;
}

function res(): {
  mock: import('node:http').ServerResponse;
  status(): number;
} {
  let code = 0;
  const mock = {
    writeHead(c: number) {
      code = c;
      return mock;
    },
    end() {
      return mock;
    },
  };
  return {
    mock: mock as unknown as import('node:http').ServerResponse,
    status: () => code,
  };
}

const uid = `U${'a'.repeat(32)}`;
const bodyText = JSON.stringify({
  events: [
    {
      type: 'message',
      source: { type: 'user', userId: uid },
      message: { id: '1', type: 'text', text: 'ping' },
    },
  ],
});

describe('handleLineWebhook', () => {
  test('isLineWebhookPath matches the route with and without account', () => {
    expect(isLineWebhookPath(req({ method: 'POST', url: '/line/webhook' }))).toBe(
      true,
    );
    expect(
      isLineWebhookPath(req({ method: 'POST', url: '/line/webhook/l0' })),
    ).toBe(true);
    expect(isLineWebhookPath(req({ method: 'POST', url: '/mcp' }))).toBe(false);
  });

  test('valid signature emits inbound events and replies 200', async () => {
    const emitted: unknown[] = [];
    const r = res();
    await handleLineWebhook(
      req({ method: 'POST', url: '/line/webhook', body: bodyText, sig: sign(bodyText) }),
      r.mock,
      (e) => emitted.push(e),
    );
    expect(r.status()).toBe(200);
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { text: string }).text).toBe('ping');
  });

  test('wrong signature is rejected with 401 and emits nothing', async () => {
    const emitted: unknown[] = [];
    const r = res();
    await handleLineWebhook(
      req({ method: 'POST', url: '/line/webhook', body: bodyText, sig: sign('nope') }),
      r.mock,
      (e) => emitted.push(e),
    );
    expect(r.status()).toBe(401);
    expect(emitted).toHaveLength(0);
  });

  test('unknown account returns 404', async () => {
    const r = res();
    await handleLineWebhook(
      req({ method: 'POST', url: '/line/webhook/nope', body: bodyText, sig: sign(bodyText) }),
      r.mock,
      () => undefined,
    );
    expect(r.status()).toBe(404);
  });
});
