import { randomBytes } from 'node:crypto';
import {
  DiscordTokenError,
  verifyDiscordBotToken,
} from '@metro-labs/discord-bot/verify';
import {
  TelegramTokenError,
  verifyTelegramBotToken,
} from '@metro-labs/telegram-bot/verify';
import {
  parsePrivateKey,
  ThreemaGatewayError,
  verifyThreemaGateway,
} from '@metro-labs/threema/verify';
import { ApiError } from '@metro-labs/http/api-error';
import { bodyField } from '@metro-labs/http/api-http';
import { ensureStationDeps } from './runtime-deps.js';
import { publicBaseOrDefault } from '../files/attach-serve.js';
import {
  discardXmtpDb,
  newXmtpDbPath,
  verifyXmtpKeyOutOfProcess,
  XmtpAttachError,
  type VerifyXmtpKey,
} from './attach-xmtp.js';

export const ATTACHABLE_STATIONS = [
  'discord-bot',
  'telegram-bot',
  'threema',
  'xmtp',
  'webhook',
] as const;

export type AttachStation = (typeof ATTACHABLE_STATIONS)[number];

export class StationAttachError extends ApiError {}

export interface AttachInput {
  station: AttachStation;
  token?: unknown;
  gatewayId?: unknown;
  secret?: unknown;
  privateKey?: unknown;
}

export interface OneTimeSecret {
  label: string;
  value: string;
  note: string;
}

export interface PreparedAccount {
  config: Record<string, unknown>;
  identity: Record<string, string>;
  secret?: OneTimeSecret;
  discard?: () => void;
}

const TOKEN_RE = /^[A-Za-z0-9._:-]{8,256}$/;

const SECP256K1_ORDER = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);

export function attachInputOf(station: AttachStation, body: unknown): AttachInput {
  return {
    station,
    token: bodyField(body, 'token'),
    gatewayId: bodyField(body, 'gatewayId'),
    secret: bodyField(body, 'secret'),
    privateKey: bodyField(body, 'privateKey'),
  };
}

export function isAttachStation(raw: unknown): raw is AttachStation {
  return (
    typeof raw === 'string' &&
    (ATTACHABLE_STATIONS as readonly string[]).includes(raw)
  );
}

function requireToken(raw: unknown, label: string): string {
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (token === '')
    throw new StationAttachError(`a ${label} bot token is required`, 400);
  if (!TOKEN_RE.test(token))
    throw new StationAttachError(
      `that does not look like a ${label} bot token`,
      400,
    );
  return token;
}

function rejected(err: unknown, own: boolean, fallback: string): never {
  throw new StationAttachError(
    own && err instanceof Error ? err.message : fallback,
    400,
  );
}

async function prepareDiscord(raw: unknown): Promise<PreparedAccount> {
  const token = requireToken(raw, 'Discord');
  try {
    const bot = await verifyDiscordBotToken(token);
    if (!bot.messageContent)
      throw new StationAttachError(
        'this Discord application does not have the Message Content intent enabled. Turn it on under Bot / Privileged Gateway Intents in the developer portal, then attach it again',
        400,
      );
    return {
      config: { token },
      identity: { userId: bot.userId, username: bot.username },
    };
  } catch (err) {
    if (err instanceof StationAttachError) throw err;
    return rejected(
      err,
      err instanceof DiscordTokenError,
      'Discord rejected that bot token',
    );
  }
}

async function prepareTelegram(raw: unknown): Promise<PreparedAccount> {
  const token = requireToken(raw, 'Telegram');
  try {
    const bot = await verifyTelegramBotToken(token);
    return {
      config: { token },
      identity: { botId: String(bot.botId), username: bot.username },
    };
  } catch (err) {
    return rejected(
      err,
      err instanceof TelegramTokenError,
      'Telegram rejected that bot token',
    );
  }
}

export function newXmtpPrivateKey(): string {
  for (;;) {
    const hex = randomBytes(32).toString('hex');
    const value = BigInt(`0x${hex}`);
    if (value > 0n && value < SECP256K1_ORDER) return `0x${hex}`;
  }
}

async function prepareXmtp(verify: VerifyXmtpKey): Promise<PreparedAccount> {
  const privateKey = newXmtpPrivateKey();
  const dbPath = newXmtpDbPath();
  const identity = await verify(privateKey, dbPath).catch((err: unknown) =>
    rejected(
      err,
      err instanceof XmtpAttachError,
      'Metro could not open an XMTP inbox with the key it generated, so nothing was attached',
    ),
  );
  return {
    config: { privateKey, dbPath },
    identity: { inboxId: identity.inboxId, address: identity.address },
    secret: {
      label: 'xmtp private key',
      value: privateKey,
      note: 'Metro generated this key, opened inbox ' +
        `${identity.inboxId} with it, and stores it with the account. ` +
        'It is shown once, here, and is never returned by any API again.',
    },
    discard: () => {
      discardXmtpDb(identity.dbPath);
    },
  };
}

export const hookUrl = (webhookId: string, secret: string): string =>
  `${publicBaseOrDefault().replace(/\/+$/, '')}/api/webhooks/${webhookId}/${secret}`;

const WEBHOOK_ID_FLOOR = 10n ** 18n;

export function newWebhookId(): string {
  const raw = BigInt(`0x${randomBytes(8).toString('hex')}`);
  return String(WEBHOOK_ID_FLOOR + (raw % (9n * WEBHOOK_ID_FLOOR)));
}

export const threemaCallbackUrl = (callbackId: string, token: string): string =>
  `${publicBaseOrDefault().replace(/\/+$/, '')}/api/threema/${callbackId}/${token}`;

function requireText(raw: unknown, label: string): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '')
    throw new StationAttachError(`the Threema ${label} is required`, 400);
  return text;
}

async function prepareThreema(input: AttachInput): Promise<PreparedAccount> {
  const gatewayId = requireText(input.gatewayId, 'Gateway ID');
  const secret = requireText(input.secret, 'API secret');
  const privateKey = requireText(input.privateKey, 'private key');
  try {
    const identity = await verifyThreemaGateway({ gatewayId, secret, privateKey });
    const callbackId = newWebhookId();
    const callbackToken = randomBytes(48).toString('base64url');
    return {
      config: {
        gatewayId: identity.gatewayId,
        secret,
        privateKey: parsePrivateKey(privateKey) ?? privateKey,
        callbackId,
        callbackToken,
        createdAt: new Date().toISOString(),
      },
      identity: {
        gatewayId: identity.gatewayId,
        credits: String(identity.credits),
        callback: threemaCallbackUrl(callbackId, callbackToken),
      },
    };
  } catch (err) {
    if (err instanceof StationAttachError) throw err;
    return rejected(
      err,
      err instanceof ThreemaGatewayError,
      'Threema rejected those Gateway credentials',
    );
  }
}

function prepareWebhook(): PreparedAccount {
  const secret = randomBytes(48).toString('base64url');
  const webhookId = newWebhookId();
  return {
    config: { secret, webhookId, createdAt: new Date().toISOString() },
    identity: { endpoint: hookUrl(webhookId, secret) },
  };
}

export async function prepareAccount(
  input: AttachInput,
  verify: VerifyXmtpKey = verifyXmtpKeyOutOfProcess,
): Promise<PreparedAccount> {
  ensureStationDeps(input.station);
  if (input.station === 'discord-bot') return prepareDiscord(input.token);
  if (input.station === 'telegram-bot') return prepareTelegram(input.token);
  if (input.station === 'webhook') return prepareWebhook();
  if (input.station === 'threema') return prepareThreema(input);
  return prepareXmtp(verify);
}
