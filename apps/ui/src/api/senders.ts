import { accountPath } from './attach.js';
import { call } from './client.js';
import { filled, isRecord } from './read.js';

export interface SenderCard {
  id: string;
  name?: string;
  handle?: string;
}

export async function fetchSenderCards(agentId: string, station: string, accountId: string): Promise<SenderCard[]> {
  const body = await call({ method: 'GET', path: `${accountPath(agentId, station, accountId)}/profiles` });
  if (!isRecord(body) || !Array.isArray(body.senders)) return [];
  return body.senders.flatMap((raw): SenderCard[] => {
    if (!isRecord(raw) || typeof raw.id !== 'string') return [];
    const name = filled(raw.name);
    const handle = filled(raw.handle);
    return [{ id: raw.id, ...(name === null ? {} : { name }), ...(handle === null ? {} : { handle }) }];
  });
}

const telegramLink = (id: string, handle: string | undefined): string | null => {
  if (handle?.startsWith('@') === true) return `https://t.me/${handle.slice(1)}`;
  return /^\d+$/.test(id) ? `tg://user?id=${id}` : null;
};

const whatsappLink = (id: string): string | null => {
  const number = /^(\d+)@s\.whatsapp\.net$/.exec(id)?.[1] ?? /^\+?(\d{6,})$/.exec(id)?.[1];
  return number === undefined ? null : `https://wa.me/${number}`;
};

const LINKS: Record<string, (id: string, handle: string | undefined) => string | null> = {
  'telegram-bot': telegramLink,
  telegram: telegramLink,
  'discord-bot': (id) => (/^\d+$/.test(id) ? `https://discord.com/users/${id}` : null),
  whatsapp: (id, handle) => whatsappLink(id) ?? (handle === undefined ? null : whatsappLink(handle)),
  threema: (id) => (/^[A-Z0-9*]{8}$/i.test(id) ? `https://threema.id/${id.toUpperCase()}` : null),
  outlook: (id) => (id.includes('@') && !id.startsWith('@') ? `mailto:${id}` : null),
};

export const chatLink = (station: string, id: string, handle?: string): string | null => LINKS[station]?.(id, handle) ?? null;
