import { policyOf, type ToolPolicy } from './policy.js';
import { filled, isRecord } from './read.js';
import { call } from './client.js';
import {
  isAttachSession,
  toIdentity,
  toSession,
  type AttachSession,
} from './attach-session.js';

export type AttachFieldKind = 'text' | 'tel' | 'number';

export interface AttachField {
  key: string;
  label: string;
  placeholder: string;
  secret: boolean;
  kind: AttachFieldKind;
  optional?: boolean;
  hint?: string;
}

export interface HintLink {
  text: string;
  href: string;
}

export interface StationForm {
  label: string;
  hint: string;
  links?: HintLink[];
  interactive: boolean;
  fields: AttachField[];
}


export const STATION_FORMS: Record<string, StationForm> = {
  'discord-bot': {
    label: 'Discord bot',
    hint: 'Paste the bot token from the Discord developer portal. Message Content must be enabled under Privileged Gateway Intents.',
    links: [
      {
        text: 'Discord developer portal',
        href: 'https://discord.com/developers/applications',
      },
    ],
    interactive: false,
    fields: [
      {
        key: 'token',
        label: 'Bot token',
        placeholder: 'MTIz...',
        secret: true,
        kind: 'text',
      },
    ],
  },
  'telegram-bot': {
    label: 'Telegram bot',
    hint: 'Paste the bot token BotFather gave you.',
    links: [{ text: 'BotFather', href: 'https://t.me/BotFather' }],
    interactive: false,
    fields: [
      {
        key: 'token',
        label: 'Bot token',
        placeholder: '123456:ABC-DEF...',
        secret: true,
        kind: 'text',
      },
    ],
  },
  threema: {
    label: 'Threema',
    hint: 'A Gateway ID in end-to-end mode: the private key stays on this machine. Create the ID at gateway.threema.ch, download its key file, and paste the three values here. Messages cost Gateway credits.',
    links: [{ text: 'gateway.threema.ch', href: 'https://gateway.threema.ch/' }],
    interactive: false,
    fields: [
      {
        key: 'gatewayId',
        label: 'Gateway ID',
        placeholder: '*ABCDEFG',
        secret: false,
        kind: 'text',
      },
      {
        key: 'secret',
        label: 'API secret',
        placeholder: 'from the Gateway ID settings',
        secret: true,
        kind: 'text',
      },
      {
        key: 'privateKey',
        label: 'Private key',
        placeholder: 'private:… or 64 hex characters',
        secret: true,
        kind: 'text',
      },
    ],
  },
  xmtp: {
    label: 'XMTP',
    hint: 'Metro generates a fresh XMTP identity for this agent. The private key is shown once and never again.',
    interactive: false,
    fields: [],
  },
  'telegram': {
    label: 'Telegram',
    hint: 'Signs in as a real Telegram user. Get an api id and hash at my.telegram.org, then Telegram sends a login code. A full-account credential with ban risk, so use a dedicated number.',
    links: [{ text: 'my.telegram.org', href: 'https://my.telegram.org/apps' }],
    interactive: true,
    fields: [
      {
        key: 'apiId',
        label: 'api id',
        placeholder: '1234567',
        secret: false,
        kind: 'number',
      },
      {
        key: 'apiHash',
        label: 'api hash',
        placeholder: '32 hex characters',
        secret: true,
        kind: 'text',
      },
      {
        key: 'phone',
        label: 'Phone number',
        placeholder: '447700900123',
        secret: false,
        kind: 'tel',
      },
    ],
  },
  outlook: {
    label: 'Outlook',
    hint: 'Connects a Microsoft 365 or Outlook.com mailbox. You sign in with Microsoft in a new tab. The agent reads new mail, searches it and answers in the same thread.',
    interactive: true,
    fields: [
      {
        key: 'mailbox',
        label: 'Mailbox (optional)',
        placeholder: 'andy@company.com',
        secret: false,
        kind: 'text',
        optional: true,
        hint: 'Type the mailbox to connect, and Metro refuses any other account.',
      },
    ],
  },
  webhook: {
    label: 'Webhook',
    hint: 'Metro mints a URL to POST events to. The whole URL is the credential, so treat it like a password. Inbound only: the agent receives events and cannot reply.',
    interactive: false,
    fields: [],
  },
  whatsapp: {
    label: 'WhatsApp',
    hint: 'Links Metro as a companion device on a real WhatsApp account. Pair with a code, or leave the number blank to scan a QR. Ban risk, so use a dedicated number.',
    interactive: true,
    fields: [
      {
        key: 'phone',
        label: 'Phone number (blank to scan a QR code)',
        placeholder: '447700900123',
        secret: false,
        kind: 'tel',
        optional: true,
      },
    ],
  },
};

export function offeredStations(attachable: string[]): string[] {
  return attachable.filter((s) => STATION_FORMS[s] !== undefined);
}

export function stationLabel(station: string): string {
  return STATION_FORMS[station]?.label ?? station;
}

export interface OneTimeSecret {
  label: string;
  value: string;
  note: string;
}

export interface AttachResult {
  station: string;
  accountId: string;
  identity: Record<string, string>;
  activated: boolean;
  secret: OneTimeSecret | null;
}

function toSecret(value: unknown): OneTimeSecret | null {
  if (!isRecord(value)) return null;
  const { label, value: secret, note } = value;
  if (typeof label !== 'string' || typeof secret !== 'string') return null;
  return { label, value: secret, note: typeof note === 'string' ? note : '' };
}

export type AttachStarted =
  | { kind: 'done'; result: AttachResult }
  | { kind: 'pending'; session: AttachSession };

function toAttachResult(station: string, body: unknown): AttachResult {
  if (!isRecord(body) || typeof body.accountId !== 'string')
    throw new Error('Metro returned an unexpected response.');
  return {
    station,
    accountId: body.accountId,
    identity: toIdentity(body.identity),
    activated: body.activated === true,
    secret: toSecret(body.secret),
  };
}

export async function startAttach(
  agentId: string,
  station: string,
  fields: Record<string, string>,
): Promise<AttachStarted> {
  const body = await call({
    method: 'POST',
    path: `/${agentId}/accounts/start`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ station, ...fields }),
  });
  if (isAttachSession(body)) return { kind: 'pending', session: toSession(body) };
  return { kind: 'done', result: toAttachResult(station, body) };
}

export interface RecentSender {
  id: string;
  name: string;
  at: string;
}

const accountPath = (agentId: string, station: string, accountId: string): string =>
  `/${agentId}/accounts/${encodeURIComponent(station)}/${encodeURIComponent(accountId)}`;

export async function setPolicy(agentId: string, station: string, accountId: string, policy: ToolPolicy): Promise<ToolPolicy> {
  const body = await call({
    method: 'PUT',
    path: `${accountPath(agentId, station, accountId)}/policy`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ policy }),
  });
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  return policyOf(body.policy);
}

export async function setAllowlist(
  agentId: string,
  station: string,
  accountId: string,
  allowlist: string[],
  approvers: string[],
): Promise<string[]> {
  const body = await call({
    method: 'PUT',
    path: `${accountPath(agentId, station, accountId)}/allowlist`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allowlist, approvers }),
  });
  if (!isRecord(body) || !Array.isArray(body.allowlist)) throw new Error('Metro returned an unexpected response.');
  return body.allowlist.filter((entry): entry is string => typeof entry === 'string');
}

export async function setAccountEnabled(
  agentId: string,
  station: string,
  accountId: string,
  enabled: boolean,
): Promise<boolean> {
  const body = await call({
    method: 'PUT',
    path: `${accountPath(agentId, station, accountId)}/enabled`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!isRecord(body) || typeof body.enabled !== 'boolean') throw new Error('Metro returned an unexpected response.');
  return body.enabled;
}

export interface SenderLookup {
  query: string;
  number: string;
  exists: boolean;
  jid: string | null;
  lid: string | null;
  id: string | null;
}


export async function lookupSender(
  agentId: string,
  station: string,
  accountId: string,
  query: string,
): Promise<SenderLookup> {
  const body = await call({
    method: 'GET',
    path: `${accountPath(agentId, station, accountId)}/resolve?q=${encodeURIComponent(query)}`,
  });
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  return {
    query: filled(body.query) ?? query,
    number: filled(body.number) ?? '',
    exists: body.exists === true,
    jid: filled(body.jid),
    lid: filled(body.lid),
    id: filled(body.id),
  };
}

export async function fetchRecentSenders(
  agentId: string,
  station: string,
  accountId: string,
): Promise<RecentSender[]> {
  const body = await call({ method: 'GET', path: `${accountPath(agentId, station, accountId)}/senders` });
  if (!isRecord(body) || !Array.isArray(body.senders)) return [];
  return body.senders.flatMap((raw) =>
    isRecord(raw) && typeof raw.id === 'string'
      ? [{ id: raw.id, name: typeof raw.name === 'string' ? raw.name : '', at: typeof raw.at === 'string' ? raw.at : '' }]
      : [],
  );
}

export async function detachAccount(
  agentId: string,
  station: string,
  accountId: string,
): Promise<void> {
  await call({
    method: 'DELETE',
    path: `/${agentId}/accounts/${encodeURIComponent(station)}/${encodeURIComponent(accountId)}`,
  });
}

export interface AccountName {
  name: string | null;
  canClaim: boolean;
}

const nameOf = (body: unknown): AccountName => ({
  name: isRecord(body) && typeof body.name === 'string' && body.name !== '' ? body.name : null,
  canClaim: isRecord(body) && body.canClaim === true,
});

export async function accountName(agentId: string, station: string, accountId: string): Promise<AccountName> {
  return nameOf(await call({ method: 'GET', path: `${accountPath(agentId, station, accountId)}/name` }));
}

export async function claimAccountName(agentId: string, station: string, accountId: string, label: string): Promise<AccountName> {
  const body = await call({
    method: 'POST',
    path: `${accountPath(agentId, station, accountId)}/name`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  return { ...nameOf(body), canClaim: false };
}
