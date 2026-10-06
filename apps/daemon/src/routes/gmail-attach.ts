import { randomUUID } from 'node:crypto';
import { ApiError } from '@metro-labs/http/api-error';
import { stringOf } from '@metro-labs/http/api-http';
import { publicBaseUrl } from '../files/attach-serve.js';
import { localOwner, readLocalAgentFile, localRenewGmail } from '../agents/file-admin.js';
import { startManagedGmail } from '../stations/attach-gmail.js';
import { startGmail } from '../stations/attach-browser.js';
import type { AttachOwner, StartAttach } from '../stations/attach-session.js';
import type { AttachOutcome, DriverHooks } from '../stations/attach-driver.js';
import { assertGmailNotDeleting } from './gmail-detach.js';

export function assertAttachOwner(owner: AttachOwner): void {
  readLocalAgentFile(owner.agentId);
  if (owner.organization !== undefined && owner.organization !== localOwner()) throw new ApiError('This box changed organization. Start again.', 403);
}

function gmailHost(): string {
  const raw = publicBaseUrl();
  const url = raw === null ? null : new URL(raw);
  if (url === null || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new ApiError('Managed Gmail needs this box registered in Metro with its HTTPS address.', 400);
  return url.host;
}

interface Upgrade {
  accountId: string;
  previous: string;
}

function gmailInput(owner: AttachOwner, input: Record<string, unknown>): { fields: Record<string, unknown>; upgrade?: Upgrade } {
  if (input.mode !== 'upgrade') return { fields: { ...input, sendEnabled: false } };
  const accountId = stringOf(input.accountId);
  assertGmailNotDeleting(owner.agentId, accountId);
  const account = readLocalAgentFile(owner.agentId).stations.find((s) => s.station === 'gmail' && s.id === accountId);
  if (account === undefined) throw new ApiError('No such Gmail connection.', 404);
  if (account.config.sendEnabled !== false) throw new ApiError('Sending is already authorized for this Gmail connection.', 409);
  return {
    fields: { clientId: account.config.clientId, clientSecret: account.config.clientSecret, mailbox: account.config.accountEmail, sendEnabled: true, mode: account.config.managed === true ? 'managed' : 'byo' },
    upgrade: { accountId, previous: stringOf(account.config.authorizationId ?? account.config.refreshToken) },
  };
}

export const startGmailAttach: StartAttach = async (_station, input, hooks, owner) => {
  assertAttachOwner(owner);
  const { fields, upgrade } = gmailInput(owner, input);
  const bound: DriverHooks = {
    ...hooks,
    done: (outcome: AttachOutcome) => {
      hooks.done({ ...outcome, config: { ...outcome.config, authorizationId: randomUUID(), ...(upgrade === undefined ? {} : { gmailUpgrade: upgrade }) } });
    },
  };
  if (fields.mode !== 'managed') return startGmail(fields, bound);
  const host = gmailHost();
  return startManagedGmail({ host, owner, mailbox: fields.mailbox, sendEnabled: fields.sendEnabled === true, check: () => {
    assertAttachOwner(owner);
    if (gmailHost() !== host) throw new ApiError('This box changed address. Start again.', 409);
  } }, bound);
};

export function finishGmailUpgrade(owner: AttachOwner, config: Record<string, unknown>): ReturnType<typeof localRenewGmail> | null {
  const value = config.gmailUpgrade;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const upgrade = value as Record<string, unknown>;
  assertGmailNotDeleting(owner.agentId, stringOf(upgrade.accountId));
  const saved = { ...config };
  delete saved.gmailUpgrade;
  return localRenewGmail(owner.agentId, stringOf(upgrade.accountId), stringOf(upgrade.previous), saved);
}
