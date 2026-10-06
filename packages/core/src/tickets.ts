import { randomBytes } from 'node:crypto';

export interface TicketStore<T> {
  mint: (value: T, now?: number) => { ticket: string; expiresAt: number };
  peek: (ticket: string, now?: number) => T | undefined;
  take: (ticket: string, now?: number) => T | undefined;
  size: (now?: number) => number;
}

export function ticketStore<T>(ttlMs: number, max: number): TicketStore<T> {
  const open = new Map<string, { value: T; expiresAt: number }>();
  const prune = (now: number): void => {
    for (const [ticket, entry] of open) if (entry.expiresAt <= now) open.delete(ticket);
  };
  return {
    mint(value, now = Date.now()) {
      prune(now);
      while (open.size >= max) {
        const oldest = open.keys().next();
        if (oldest.done === true) break;
        open.delete(oldest.value);
      }
      const ticket = randomBytes(32).toString('base64url');
      const expiresAt = now + ttlMs;
      open.set(ticket, { value, expiresAt });
      return { ticket, expiresAt };
    },
    peek(ticket, now = Date.now()) {
      const entry = open.get(ticket);
      if (entry !== undefined && entry.expiresAt > now) return entry.value;
      open.delete(ticket);
      return undefined;
    },
    take(ticket, now = Date.now()) {
      const entry = open.get(ticket);
      open.delete(ticket);
      return entry !== undefined && entry.expiresAt > now ? entry.value : undefined;
    },
    size(now = Date.now()) {
      prune(now);
      return open.size;
    },
  };
}
