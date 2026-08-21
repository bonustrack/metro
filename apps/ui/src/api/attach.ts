import { call } from './client';
import { isRecord } from './accounts';
import {
  isAttachSession,
  toIdentity,
  toSession,
  type AttachSession,
} from './attach-session';

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
  discord: {
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
  telegram: {
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
  xmtp: {
    label: 'XMTP',
    hint: 'Metro generates a fresh XMTP identity for this agent, opens an inbox with it, and stores it only if that worked. The private key is shown once and never again.',
    interactive: false,
    fields: [],
  },
  'telegram-user': {
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

export const STATIONS_SHOWN = 3;

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

export function toAttachResult(station: string, body: unknown): AttachResult {
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
  token: string,
  agentId: number,
  station: string,
  fields: Record<string, string>,
): Promise<AttachStarted> {
  const body = await call(token, {
    method: 'POST',
    path: `/${agentId}/accounts/start`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ station, ...fields }),
  });
  if (isAttachSession(body)) return { kind: 'pending', session: toSession(body) };
  return { kind: 'done', result: toAttachResult(station, body) };
}

export async function detachAccount(
  token: string,
  agentId: number,
  station: string,
  accountId: string,
): Promise<void> {
  await call(token, {
    method: 'DELETE',
    path: `/${agentId}/accounts/${encodeURIComponent(station)}/${encodeURIComponent(accountId)}`,
  });
}
