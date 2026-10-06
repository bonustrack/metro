import { describe, expect, test } from 'bun:test';
import { AuthError, ForbiddenError, NotFoundError } from '@metro-labs/client/api/client';
import { makeQueryClient } from '../src/lib/queries.js';

const BASE = 'https://run-test.invalid';
const SOURCES = ['run-events', 'claude-session', 'claude-account', 'model', 'stations'];

describe('Run authorization revocation', () => {
  for (const refusal of [new AuthError('refused', true), new ForbiddenError('wrong owner'), new NotFoundError('agent missing')]) {
    test(`${refusal.constructor.name} removes private data before later network errors`, async () => {
      let signedOut = false;
      const client = makeQueryClient(() => { signedOut = true; });
      try {
        for (const source of SOURCES) client.setQueryData([source, BASE], 'private retained data');
        client.setQueryData(['run-events', 'https://other-box.invalid'], 'other box');
        client.setQueryData(['servers', BASE], 'unrelated');
        await expect(client.fetchQuery({ queryKey: ['run-events', BASE], staleTime: 0, queryFn: () => Promise.reject(refusal) })).rejects.toBe(refusal);
        for (const source of SOURCES) {
          expect(client.getQueryData([source, BASE])).toBeUndefined();
          expect(client.getQueryState([source, BASE])?.error).toBe(refusal);
        }
        const offline = new Error('network unavailable');
        await expect(client.fetchQuery({ queryKey: ['run-events', BASE], retry: false, queryFn: () => Promise.reject(offline) })).rejects.toBe(offline);
        for (const source of SOURCES) expect(client.getQueryData([source, BASE])).toBeUndefined();
        expect(client.getQueryData(['run-events', 'https://other-box.invalid'])).toBe('other box');
        expect(client.getQueryData(['servers', BASE])).toBe('unrelated');
        expect(signedOut).toBe(false);
        await client.fetchQuery({ queryKey: ['run-events', BASE], queryFn: () => Promise.resolve('fresh authorized data') });
        expect(client.getQueryData(['run-events', BASE])).toBe('fresh authorized data');
      } finally {
        client.clear();
      }
    });
  }

  test('an in-flight old snapshot cannot restore purged activity', async () => {
    const client = makeQueryClient(() => undefined);
    const pending = Promise.withResolvers<string>();
    try {
      client.setQueryData(['claude-session', BASE], 'previous snapshot');
      const inFlight = client.fetchQuery({ queryKey: ['claude-session', BASE], staleTime: 0, queryFn: () => pending.promise }).catch(() => 'cancelled');
      const refusal = new ForbiddenError('wrong owner');
      await expect(client.fetchQuery({ queryKey: ['run-events', BASE], queryFn: () => Promise.reject(refusal) })).rejects.toBe(refusal);
      pending.resolve('late private snapshot');
      await inFlight;
      expect(client.getQueryData(['claude-session', BASE])).toBeUndefined();
      expect(client.getQueryState(['claude-session', BASE])?.error).toBe(refusal);
    } finally {
      client.clear();
    }
  });

  test('model refusal cancels a pending server account lookup', async () => {
    const client = makeQueryClient(() => undefined);
    const pending = Promise.withResolvers<string>();
    try {
      client.setQueryData(['claude-account', BASE], 'old@example.invalid');
      const inFlight = client.fetchQuery({ queryKey: ['claude-account', BASE], staleTime: 0, queryFn: () => pending.promise }).catch(() => 'cancelled');
      const refusal = new ForbiddenError('wrong owner');
      await expect(client.fetchQuery({ queryKey: ['model', BASE], queryFn: () => Promise.reject(refusal) })).rejects.toBe(refusal);
      pending.resolve('late@example.invalid');
      await inFlight;
      expect(client.getQueryData(['claude-account', BASE])).toBeUndefined();
      expect(client.getQueryState(['claude-account', BASE])?.error).toBe(refusal);
    } finally {
      client.clear();
    }
  });

  test('ordinary network failures keep the explicitly disconnected snapshot', async () => {
    const client = makeQueryClient(() => undefined);
    try {
      client.setQueryData(['claude-session', BASE], 'last confirmed snapshot');
      await expect(client.fetchQuery({ queryKey: ['claude-session', BASE], staleTime: 0, retry: false, queryFn: () => Promise.reject(new Error('offline')) })).rejects.toThrow('offline');
      expect(client.getQueryData(['claude-session', BASE])).toBe('last confirmed snapshot');
    } finally {
      client.clear();
    }
  });
});
