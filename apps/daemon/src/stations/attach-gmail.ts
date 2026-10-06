import { parseMailbox, pkcePair, SignInError } from '@metro-labs/core/stations/oauth';
import { managedRequest, managedTokens } from '@metro-labs/gmail/managed';
import { ApiError } from '@metro-labs/http/api-error';
import { stringOf } from '@metro-labs/http/api-http';
import type { AttachOwner } from './attach-session.js';
import type { AttachOutcome, DriverHooks, StartedAttach } from './attach-driver.js';

interface ManagedStart {
  host: string;
  owner: AttachOwner;
  mailbox: unknown;
  sendEnabled: boolean;
  check: () => void;
}

function authorizationOf(owner: AttachOwner): string {
  if (!owner.userId || !owner.sessionId || !owner.organization || !owner.authorization) throw new ApiError('Sign in to Metro again before connecting Gmail.', 401);
  return owner.authorization;
}

function signInLink(started: Record<string, unknown>): { state: string; authorizeUrl: string; expiresAt: number } {
  const state = stringOf(started.state);
  const authorizeUrl = stringOf(started.authorizeUrl);
  const url = new URL(authorizeUrl);
  const expiresAt = started.expiresAt;
  if (!state || url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.searchParams.get('state') !== state || url.searchParams.get('redirect_uri') !== 'https://metro.box/' || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new SignInError('Metro returned an invalid Gmail sign-in link.');
  return { state, authorizeUrl, expiresAt };
}

function outcomeOf(result: Record<string, unknown>, input: ManagedStart, mailbox: string | null): AttachOutcome {
  const accountEmail = parseMailbox(result.accountEmail);
  if (accountEmail === null || (mailbox !== null && accountEmail !== mailbox) || result.managed !== true || result.managedHost !== input.host || result.sendEnabled !== input.sendEnabled) throw new SignInError('Metro returned a Gmail connection for a different mailbox or access level.');
  return { config: { ...managedTokens(result), accountEmail, managed: true, managedHost: input.host, managedOrganization: input.owner.organization, sendEnabled: input.sendEnabled }, identity: { email: accountEmail } };
}

export async function startManagedGmail(input: ManagedStart, hooks: DriverHooks): Promise<StartedAttach> {
  const { host, owner, sendEnabled, check } = input;
  const bearer = authorizationOf(owner);
  const pair = pkcePair();
  const mailbox = parseMailbox(input.mailbox);
  check();
  const started = await managedRequest('start', { host, agentId: owner.agentId, challenge: pair.challenge, ...(mailbox === null ? {} : { mailbox }), sendEnabled }, bearer);
  check();
  const { state, authorizeUrl, expiresAt } = signInLink(started);
  let cancelled = false;
  let used = false;
  return {
    expiresAt,
    prompt: { step: 'browser', prompt: sendEnabled ? 'Approve sending for this mailbox on Google. Metro write permissions stay unchanged.' : 'Choose a Google account and approve read-only Gmail access. Metro cannot send mail with this connection.', authorizeUrl },
    driver: {
      cancel: async () => {
        cancelled = true;
        await managedRequest('cancel', { state, host, agentId: owner.agentId }, bearer);
      },
      submit: async (value, authorization) => {
        if (cancelled || used || Date.now() >= expiresAt) throw new ApiError('This sign-in is finished or expired. Start again.', 409);
        if (stringOf(value.state) !== state) throw new ApiError('This sign-in belongs to another attempt.', 400);
        if (!authorization) throw new ApiError('Sign in to Metro again.', 401);
        used = true;
        try {
          if (stringOf(value.error)) {
            await managedRequest('cancel', { state, host, agentId: owner.agentId }, authorization);
            hooks.fail('Google sign-in was declined or blocked. Nothing was connected.');
            return;
          }
          const code = stringOf(value.code);
          if (!code) throw new ApiError('Google did not return a sign-in code.', 400);
          check();
          const result = await managedRequest('exchange', { state, code, verifier: pair.verifier, host, agentId: owner.agentId }, authorization);
          check();
          if (!cancelled) hooks.done(outcomeOf(result, input, mailbox));
        } catch {
          hooks.fail('Metro could not finish this Gmail sign-in. Start again.');
        }
      },
    },
  };
}
