import { randomBytes } from 'node:crypto';

const TTL_MS = 30_000;
const MAX_OPEN = 20;

interface Pending {
  subject: string;
  expiresAt: number;
}

const pending = new Map<string, Pending>();

function prune(now: number): void {
  for (const [ticket, entry] of pending) if (entry.expiresAt <= now) pending.delete(ticket);
  while (pending.size >= MAX_OPEN) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

export function mintTerminalTicket(subject: string, now = Date.now()): { ticket: string; expiresAt: number } {
  prune(now);
  const ticket = randomBytes(32).toString('base64url');
  const expiresAt = now + TTL_MS;
  pending.set(ticket, { subject, expiresAt });
  return { ticket, expiresAt };
}

export function takeTerminalTicket(ticket: string, now = Date.now()): string | null {
  const entry = pending.get(ticket);
  pending.delete(ticket);
  return entry !== undefined && entry.expiresAt > now ? entry.subject : null;
}

export const pendingTerminalTickets = (): number => pending.size;
