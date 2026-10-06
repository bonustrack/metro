import { BrowserSignIn, parseMailbox, type FetchLike } from '@metro-labs/core/stations/oauth';
import { authorizeUrl, clientOf, redeemCode, verifyMailbox } from './auth.js';

export { failureOf } from './auth.js';

export interface GmailLoginResult {
  config: Record<string, unknown>;
  identity: Record<string, string>;
}

export interface GmailLoginDeps {
  clientId?: unknown;
  clientSecret?: unknown;
  mailbox?: unknown;
  sendEnabled?: boolean;
  fetch?: FetchLike;
  now?: () => number;
}

export class GmailBrowserLogin extends BrowserSignIn<GmailLoginResult> {
  constructor(deps: GmailLoginDeps) {
    const client = clientOf(deps.clientId, deps.clientSecret);
    const mailbox = parseMailbox(deps.mailbox);
    const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
    const now = deps.now ?? Date.now;
    const sendEnabled = deps.sendEnabled === true;
    super({
      authorize: (challenge, state) => authorizeUrl(client, challenge, state, mailbox, sendEnabled),
      redeem: async (code, verifier) => {
        const tokens = await redeemCode(client, code, verifier, fetchImpl, now(), sendEnabled);
        const email = await verifyMailbox(tokens.accessToken, fetchImpl, mailbox);
        return {
          config: { accountEmail: email, ...client, ...tokens, sendEnabled, createdAt: new Date(now()).toISOString() },
          identity: { email },
        };
      },
    });
  }
}
