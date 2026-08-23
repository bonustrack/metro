import { API } from './api-base.js';

export class DiscordTokenError extends Error {}

export interface DiscordBotIdentity {
  userId: string;
  username: string;
  messageContent: boolean;
}

const MESSAGE_CONTENT = 1 << 18;
const MESSAGE_CONTENT_LIMITED = 1 << 19;
const TIMEOUT_MS = 10_000;

function botFetch(token: string, path: string): Promise<Response> {
  return fetch(`${API}${path}`, {
    headers: {
      authorization: `Bot ${token}`,
      'user-agent': 'metro-daemon (https://github.com/bonustrack/metro)',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    throw new DiscordTokenError('Discord returned a response Metro could not read');
  }
}

async function selfUser(token: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await botFetch(token, '/users/@me');
  } catch {
    throw new DiscordTokenError(
      'could not reach the Discord API to check that bot token',
    );
  }
  if (res.status === 401 || res.status === 403)
    throw new DiscordTokenError('Discord rejected that bot token');
  if (!res.ok)
    throw new DiscordTokenError(
      `Discord answered ${res.status} while checking that bot token`,
    );
  return readJson(res);
}

async function messageContentEnabled(token: string): Promise<boolean> {
  try {
    const res = await botFetch(token, '/applications/@me');
    if (!res.ok) return true;
    const flags = (await readJson(res)).flags;
    if (typeof flags !== 'number') return true;
    return (flags & (MESSAGE_CONTENT | MESSAGE_CONTENT_LIMITED)) !== 0;
  } catch {
    return true;
  }
}

export async function verifyDiscordBotToken(
  token: string,
): Promise<DiscordBotIdentity> {
  const me = await selfUser(token);
  const userId = typeof me.id === 'string' ? me.id : '';
  if (userId === '')
    throw new DiscordTokenError('Discord returned no bot identity for that token');
  if (me.bot !== true)
    throw new DiscordTokenError(
      'that token belongs to a Discord user, not a bot application',
    );
  return {
    userId,
    username: typeof me.username === 'string' ? me.username : '',
    messageContent: await messageContentEnabled(token),
  };
}
