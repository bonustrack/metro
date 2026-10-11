import { expect, test } from 'bun:test';
import { ApiError } from '../src/api-error.ts';
import { INITIALIZE, mcpPost, verifyRemoteMcp } from '../src/connector-mcp.ts';
import { ConnectorVerifyError } from '../src/connector-url.ts';

const URL_MCP = new URL('https://mcp.example/path?key=secret');

for (const status of [403, 404, 424, 503]) {
  test(`mcpPost preserves the exact ApiError with status ${status} from a guarded transport`, async () => {
    const refusal = new ApiError('The organization connector is unavailable.', status);
    await expect(mcpPost(URL_MCP, { kind: 'none' }, INITIALIZE, {
      timeoutMs: 1000,
      fetch: async () => { throw refusal; },
    })).rejects.toBe(refusal);
  });
}

test('verification also preserves the typed transport status', async () => {
  const refusal = new ApiError('The organization connector is unavailable.', 503);
  await expect(verifyRemoteMcp(URL_MCP, { kind: 'none' }, async () => { throw refusal; })).rejects.toBe(refusal);
});

test('untyped connection failures remain ConnectorVerifyError refusals', async () => {
  const request = mcpPost(URL_MCP, { kind: 'none' }, INITIALIZE, {
    timeoutMs: 1000,
    fetch: async () => { throw new Error('network unavailable'); },
  });
  await expect(request).rejects.toBeInstanceOf(ConnectorVerifyError);
  await expect(request).rejects.toMatchObject({ status: 400 });
  await expect(request).rejects.toThrow('Metro could not reach mcp.example');
});
