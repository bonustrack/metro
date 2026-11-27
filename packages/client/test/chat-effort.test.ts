import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearAccount } from '../src/auth/account.ts';
import { sendTurn } from '../src/api/chat-turns.js';
import { installTestAccount } from './account-fixture.js';

const realFetch = globalThis.fetch;
let bodies: unknown[] = [];

beforeEach(() => {
  clearAccount();
  installTestAccount();
  bodies = [];
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Promise.resolve(new Response(JSON.stringify({ turn: 'msg00000001' }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  clearAccount();
});

describe('a turn start carries the effort the person chose', () => {
  test('the effort goes in the body only when one is chosen', async () => {
    await sendTurn('emma.ts.net', 'send.ticket.sig', 'hi', 'high');
    await sendTurn('emma.ts.net', 'send.ticket.sig', 'hi');
    expect(bodies).toEqual([{ ticket: 'send.ticket.sig', text: 'hi', effort: 'high' }, { ticket: 'send.ticket.sig', text: 'hi' }]);
  });
});
