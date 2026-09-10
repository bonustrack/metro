import { call } from './client.js';
import { isRecord } from './accounts.js';
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
    hint: 'Uses a Threema Gateway ID in end-to-end mode, so the private key stays on this machine and Threema cannot read the messages. Create the ID at gateway.threema.ch, pick end-to-end mode, download its key file, then paste the ID, the API secret and the private key here. Metro then shows a callback URL to paste into the ID settings. Messages cost Gateway credits, and the station carries text only.',
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
    hint: 'Metro generates a fresh XMTP identity for this agent, opens an inbox with it, and stores it only if that worked. The private key is shown once and never again.',
    interactive: false,
    fields: [],
  },
  'telegram': {
    label: 'Telegram',
    hint: 'Signs in as a real Telegram user. Create an application at my.telegram.org to get the api id and hash, then Telegram sends a login code to the number below. This is a full-account credential and carries Telegram ban risk, so use a number you are willing to dedicate to the agent.',
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
  webhook: {
    label: 'Webhook',
    hint: 'Metro mints a URL to POST events to. The whole URL is the credential, so paste it into the provider and there is no secret or signature header to configure. Treat it like a password: anyone holding it can post events to this agent. Webhook lines are inbound only, so the agent receives events and cannot reply on them.',
    interactive: false,
    fields: [],
  },
  whatsapp: {
    label: 'WhatsApp',
    hint: 'Links Metro as a companion device on a real WhatsApp account. Give a phone number to pair with an 8-character code, or leave it blank to scan a QR code instead. Carries WhatsApp ban risk, so use a dedicated number.',
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

export function stationLabel(station: string): string {
  return STATION_FORMS[station]?.label ?? station;
}

const STATIONS_SHOWN = 3;

export function matchStations(
  stations: string[],
  query: string,
  shown = STATIONS_SHOWN,
): string[] {
  const q = query.trim().toLowerCase();
  if (q === '') return stations.slice(0, shown);
  return stations.filter(
    (s) =>
      s.toLowerCase().includes(q) || stationLabel(s).toLowerCase().includes(q),
  );
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

export async function setAllowlist(
  agentId: string,
  station: string,
  accountId: string,
  allowlist: string[],
): Promise<string[]> {
  const body = await call({
    method: 'PUT',
    path: `${accountPath(agentId, station, accountId)}/allowlist`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allowlist }),
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
