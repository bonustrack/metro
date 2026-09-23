import { ticketStore } from '@metro-labs/core/tickets';

export interface TerminalGrant {
  subject: string;
  session: string;
}

const tickets = ticketStore<TerminalGrant>(30_000, 20);

export const mintTerminalTicket = (subject: string, session: string, now = Date.now()): { ticket: string; expiresAt: number } =>
  tickets.mint({ subject, session }, now);

export const takeTerminalTicket = (ticket: string, now = Date.now()): TerminalGrant | null => tickets.take(ticket, now) ?? null;

export const pendingTerminalTickets = (): number => tickets.size();
