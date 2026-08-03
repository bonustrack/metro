import { call } from './client';
import { isRecord } from './accounts';

export interface AttachField {
  key: 'token';
  label: string;
  placeholder: string;
  secret: boolean;
}

export interface StationForm {
  label: string;
  hint: string;
  fields: AttachField[];
}

export const STATION_FORMS: Record<string, StationForm> = {
  discord: {
    label: 'Discord bot',
    hint: 'Paste the bot token from the Discord developer portal. Message Content must be enabled under Privileged Gateway Intents.',
    fields: [
      {
        key: 'token',
        label: 'Bot token',
        placeholder: 'MTIz...',
        secret: true,
      },
    ],
  },
  telegram: {
    label: 'Telegram bot',
    hint: 'Paste the bot token BotFather gave you.',
    fields: [
      {
        key: 'token',
        label: 'Bot token',
        placeholder: '123456:ABC-DEF...',
        secret: true,
      },
    ],
  },
  xmtp: {
    label: 'XMTP',
    hint: 'Metro generates a fresh XMTP identity for this agent, opens an inbox with it, and stores it only if that worked. The private key is shown once and never again.',
    fields: [],
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

export async function attachAccount(
  token: string,
  agentId: number,
  station: string,
  fields: Record<string, string>,
): Promise<AttachResult> {
  const body = await call(token, {
    method: 'POST',
    path: `/${agentId}/accounts/start`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ station, ...fields }),
  });
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
