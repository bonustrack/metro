import { randomBytes } from 'node:crypto';
import { ApiError } from '@metro-labs/http/api-error';

const TICKET_MS = 10 * 60_000;
const TICKETS_MAX = 1000;
const TICKETS_PER_OWNER = 20;

export interface EnrollTicket {
  owner: string;
  agent: string;
  userId: string;
}

interface Open {
  value: EnrollTicket;
  expiresAt: number;
}

export class EnrollTickets {
  private readonly open = new Map<string, Open>();

  mint(value: EnrollTicket, now: number): { ticket: string; expiresAt: number } {
    this.prune(now);
    for (const [ticket, entry] of this.open)
      if (entry.value.owner === value.owner && entry.value.agent === value.agent) this.open.delete(ticket);
    const owned = [...this.open.values()].filter((entry) => entry.value.owner === value.owner).length;
    if (owned >= TICKETS_PER_OWNER) throw new ApiError('This organization has too many enrollments waiting. Try again in ten minutes.', 429);
    if (this.open.size >= TICKETS_MAX) throw new ApiError('Enrollment is busy. Try again in ten minutes.', 503);
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = now + TICKET_MS;
    this.open.set(ticket, { value, expiresAt });
    return { ticket, expiresAt };
  }

  peek(ticket: string, now: number): EnrollTicket | undefined {
    const entry = this.open.get(ticket);
    return entry !== undefined && entry.expiresAt > now ? entry.value : undefined;
  }

  take(ticket: string, now: number): EnrollTicket | undefined {
    const value = this.peek(ticket, now);
    this.open.delete(ticket);
    return value;
  }

  private prune(now: number): void {
    for (const [ticket, entry] of this.open) if (entry.expiresAt <= now) this.open.delete(ticket);
  }
}
