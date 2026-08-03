import { TelegramClient } from '@mtcute/bun';

export class TelegramUserLoginError extends Error {}

export interface TelegramUserCredentials {
  apiId: number;
  apiHash: string;
  phone: string;
}

export interface TelegramUserSignedIn {
  config: { session: string; apiId: number; apiHash: string };
  identity: { userId: string; displayName: string };
}

export type TelegramUserStep = 'code' | 'password';

const PHONE_RE = /^[0-9]{6,15}$/;
const API_HASH_RE = /^[a-f0-9]{32}$/i;

export function rpcErrorText(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const text = (err as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

export function needsPassword(err: unknown): boolean {
  return rpcErrorText(err) === 'SESSION_PASSWORD_NEEDED';
}

export function readableAuthError(err: unknown): string {
  const text = rpcErrorText(err);
  if (text.startsWith('PHONE_CODE_INVALID')) return 'that login code is not right';
  if (text.startsWith('PHONE_CODE_EXPIRED'))
    return 'that login code has expired, start again';
  if (text.startsWith('PHONE_NUMBER_INVALID'))
    return 'Telegram does not recognise that phone number';
  if (text.startsWith('PHONE_NUMBER_BANNED'))
    return 'Telegram has banned that phone number';
  if (text.startsWith('PASSWORD_HASH_INVALID'))
    return 'that two-step verification password is not right';
  if (text.startsWith('FLOOD_WAIT'))
    return 'Telegram is rate-limiting this number, try again later';
  return text === '' ? 'Telegram refused the sign-in' : `Telegram said ${text}`;
}

export function validateCredentials(raw: {
  apiId: unknown;
  apiHash: unknown;
  phone: unknown;
}): TelegramUserCredentials {
  const apiId = Number(raw.apiId);
  if (!Number.isInteger(apiId) || apiId <= 0)
    throw new TelegramUserLoginError(
      'api id must be the integer from my.telegram.org',
    );
  const apiHash = typeof raw.apiHash === 'string' ? raw.apiHash.trim() : '';
  if (!API_HASH_RE.test(apiHash))
    throw new TelegramUserLoginError(
      'api hash must be the 32-character hash from my.telegram.org',
    );
  const phone =
    typeof raw.phone === 'string' ? raw.phone.replace(/[^0-9]/g, '') : '';
  if (!PHONE_RE.test(phone))
    throw new TelegramUserLoginError(
      'phone must be an international number, digits only',
    );
  return { apiId, apiHash, phone };
}

interface SentCodeLike {
  phoneCodeHash: string;
  length: number;
  type: string;
}

const isSentCode = (v: unknown): v is SentCodeLike =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { phoneCodeHash?: unknown }).phoneCodeHash === 'string';

interface UserLike {
  id: number;
  displayName: string;
}

export class TelegramUserLogin {
  private tg: TelegramClient;
  private phoneCodeHash = '';
  private closed = false;

  constructor(private creds: TelegramUserCredentials) {
    this.tg = new TelegramClient({
      apiId: creds.apiId,
      apiHash: creds.apiHash,
      storage: ':memory:',
    });
  }

  async requestCode(): Promise<{ step: TelegramUserStep; length: number }> {
    await this.tg.connect();
    const sent = await this.tg
      .sendCode({ phone: this.creds.phone })
      .catch((err: unknown) => {
        throw new TelegramUserLoginError(readableAuthError(err));
      });
    if (!isSentCode(sent))
      throw new TelegramUserLoginError(
        'Telegram signed this number in without a code, which Metro cannot use',
      );
    this.phoneCodeHash = sent.phoneCodeHash;
    return { step: 'code', length: sent.length };
  }

  async submitCode(raw: string): Promise<TelegramUserSignedIn | 'password'> {
    const phoneCode = raw.replace(/[^0-9]/g, '');
    if (phoneCode === '')
      throw new TelegramUserLoginError('enter the login code Telegram sent you');
    try {
      const user = await this.tg.signIn({
        phone: this.creds.phone,
        phoneCodeHash: this.phoneCodeHash,
        phoneCode,
      });
      return await this.exportFor(user);
    } catch (err) {
      if (needsPassword(err)) return 'password';
      throw new TelegramUserLoginError(readableAuthError(err));
    }
  }

  async submitPassword(password: string): Promise<TelegramUserSignedIn> {
    if (password === '')
      throw new TelegramUserLoginError(
        'enter your Telegram two-step verification password',
      );
    try {
      const user = await this.tg.checkPassword(password);
      return await this.exportFor(user);
    } catch (err) {
      throw new TelegramUserLoginError(readableAuthError(err));
    }
  }

  private async exportFor(user: UserLike): Promise<TelegramUserSignedIn> {
    const session = await this.tg.exportSession();
    await this.close();
    return {
      config: {
        session,
        apiId: this.creds.apiId,
        apiHash: this.creds.apiHash,
      },
      identity: {
        userId: String(user.id),
        displayName: user.displayName,
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tg.destroy().catch(() => undefined);
  }
}
