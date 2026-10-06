import { describe, expect, test } from 'bun:test';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { exchangeGmailCode, gmailProfile, refreshGmailTokens, revokeGmailToken } from '../src/gmail/provider.js';
import { CONFIG, PKCE, READ_SCOPE } from './gmail-fake.js';

const exchange = (fetch: FetchLike) => exchangeGmailCode(fetch, CONFIG, 'fake-code', PKCE.verifier, false, () => 1000);
const refresh = (fetch: FetchLike) => refreshGmailTokens(fetch, CONFIG, 'fake-refresh', false, () => 1000);
const profile = (fetch: FetchLike) => gmailProfile(fetch, 'fake-access');
const revoke = (fetch: FetchLike) => revokeGmailToken(fetch, 'fake-refresh');
const reply = (response: Response): FetchLike => () => Promise.resolve(response.clone());
const TOKENS = { access_token: 'fake-access', refresh_token: 'fake-refresh', token_type: 'Bearer', expires_in: 3600, scope: READ_SCOPE };

describe('managed Gmail provider service status', () => {
  test('every network failure is a sanitized 503 instead of a proxy-replaced 502', async () => {
    for (const operation of [exchange, refresh, profile, revoke]) {
      await expect(operation(() => Promise.reject(new Error('private upstream details')))).rejects.toMatchObject({
        status: 503, message: 'Google could not be reached for Gmail sign-in. Try again.',
      });
    }
  });

  test('token endpoint service failures are 503 but explicit OAuth denials remain 400', async () => {
    for (const operation of [exchange, refresh]) {
      for (const status of [302, 403, 429, 500, 502, 503, 504]) {
        await expect(operation(reply(Response.json({ error_description: 'private' }, { status })))).rejects.toMatchObject({
          status: 503, message: 'Google refused this Gmail sign-in. Connect Gmail again.',
        });
      }
      for (const status of [400, 401]) {
        await expect(operation(reply(Response.json({ error: 'invalid_grant' }, { status })))).rejects.toMatchObject({ status: 400 });
      }
    }
  });

  test('malformed token or profile response bodies are 503', async () => {
    for (const operation of [exchange, refresh, profile]) {
      for (const response of [new Response('not-json'), Response.json(null), Response.json([])]) {
        await expect(operation(reply(response))).rejects.toMatchObject({
          status: 503, message: 'Google returned an invalid Gmail sign-in response.',
        });
      }
    }
  });

  test('missing tokens and invalid lifetimes are 503 while scope refusal stays 400', async () => {
    for (const operation of [exchange, refresh]) {
      await expect(operation(reply(Response.json({ ...TOKENS, access_token: '' })))).rejects.toMatchObject({
        status: 503, message: 'Google did not return the Gmail tokens needed. Connect Gmail again.',
      });
      await expect(operation(reply(Response.json({ ...TOKENS, expires_in: 0 })))).rejects.toMatchObject({
        status: 503, message: 'Google returned an invalid Gmail token lifetime.',
      });
      await expect(operation(reply(Response.json({ ...TOKENS, scope: '' })))).rejects.toMatchObject({ status: 400 });
    }
  });

  test('profile verification failures and missing mailbox identity are 503', async () => {
    await expect(profile(reply(new Response('private', { status: 403 })))).rejects.toMatchObject({
      status: 503, message: 'Google could not verify this Gmail mailbox. Check Gmail access and connect again.',
    });
    await expect(profile(reply(Response.json({})))).rejects.toMatchObject({
      status: 503, message: 'Google did not identify this Gmail mailbox.',
    });
  });

  test('revoke service failures are 503 while explicit already-revoked success remains idempotent', async () => {
    for (const status of [302, 400, 401, 403, 429, 500, 502, 503, 504]) {
      await expect(revoke(reply(Response.json({ error: 'invalid_request' }, { status })))).rejects.toMatchObject({
        status: 503, message: 'Google could not revoke this Gmail sign-in. Try again.',
      });
    }
    await expect(revoke(reply(Response.json({ error: 'invalid_token' }, { status: 400 })))).resolves.toBeUndefined();
  });
});
