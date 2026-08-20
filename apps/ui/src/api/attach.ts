import { call } from './client';
import { isRecord } from './accounts';
import {
  isAttachSession,
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
    hint: 'Metro mints a URL and a signing secret. Sign each request body with HMAC-SHA256 and send it as the x-hub-signature-256 header, GitHub style. The URL is public: the signature is its only gate, and an unsigned request is accepted only if you attach no secret. An agent receives webhook events and cannot reply on that line.',
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

function toIdentity(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, raw] of Object.entries(value))
    if (typeof raw === 'string' && raw !== '') out[key] = raw;
  return out;
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
