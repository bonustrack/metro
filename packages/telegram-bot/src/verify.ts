export class TelegramTokenError extends Error {}

export interface TelegramBotIdentity {
  botId: number;
  username: string;
}

const API = 'https://api.telegram.org';
const TIMEOUT_MS = 10_000;

interface GetMe {
  ok?: unknown;
  result?: { id?: unknown; username?: unknown; is_bot?: unknown };
}

export async function verifyTelegramBotToken(
  token: string,
): Promise<TelegramBotIdentity> {
  let res: Response;
  try {
    res = await fetch(`${API}/bot${token}/getMe`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new TelegramTokenError(
      'could not reach the Telegram API to check that bot token',
    );
  }
  const body = (await res.json().catch(() => null)) as GetMe | null;
  const me = body?.ok === true ? body.result : undefined;
  if (!me) throw new TelegramTokenError('Telegram rejected that bot token');
  if (typeof me.id !== 'number' || me.is_bot !== true)
    throw new TelegramTokenError('that token does not belong to a Telegram bot');
  return {
    botId: me.id,
    username: typeof me.username === 'string' ? me.username : '',
  };
}
