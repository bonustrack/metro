import { describe, expect, test } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import { cors } from '../src/api-http.ts';

describe('cross-origin answers', () => {
  test('every method the page sends is allowed, PATCH included', () => {
    const methods = cors({ headers: { origin: 'https://metro.box' } } as IncomingMessage)['access-control-allow-methods']?.split(', ') ?? [];
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) expect(methods).toContain(method);
  });
});
