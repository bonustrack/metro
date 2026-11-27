import type { IncomingMessage } from 'node:http';
import type { ChatFile } from '@metro-labs/core/chat';
import { ApiError } from '@metro-labs/http/api-error';
import { apiSession, type ApiSession } from '@metro-labs/http/api-http';
import { textDigest, verifyChatTicket, type ChatTicket } from '@metro-labs/http/chat-ticket';
import type { KeySource } from '@metro-labs/http/user-token';

export interface TicketFacts {
  keys: KeySource;
  owner: () => string | null;
  server: () => string | null;
  now: () => number;
}

const refused = (why: string): ApiError => new ApiError(why, 403);

export async function chatCaller(req: IncomingMessage): Promise<ApiSession & { userId: string }> {
  const session = await apiSession(req);
  const userId = session?.userId;
  if (session === null || userId === undefined) throw new ApiError('unauthorized', 401);
  return { ...session, userId };
}

export class ChatGate {
  private readonly spent = new Map<string, number>();

  constructor(private readonly facts: TicketFacts) {}

  async check(token: unknown, user: string): Promise<ChatTicket> {
    const now = this.facts.now();
    const ticket = await verifyChatTicket(token, this.facts.keys, now);
    if (ticket === null) throw refused('This chat needs a fresh ticket from metro.box. Reload the chat.');
    if (ticket.organization !== this.facts.owner()) throw refused('This chat belongs to another organization.');
    if (ticket.agent !== this.facts.server()) throw refused('This chat is for another agent.');
    if (ticket.user !== user) throw refused('This chat ticket was made for someone else.');
    return ticket;
  }

  async send(token: unknown, user: string, text: string): Promise<ChatTicket & { message: string }> {
    const ticket = await this.check(token, user);
    const message = ticket.message;
    if (ticket.act !== 'send' || message === null || ticket.digest !== textDigest(text)) throw refused('This ticket does not send this message.');
    return { ...ticket, message };
  }

  async fileOf(token: unknown, user: string, message: string, id: string): Promise<{ ticket: ChatTicket; file: ChatFile }> {
    const ticket = await this.check(token, user);
    const file = ticket.act === 'send' && ticket.message === message ? ticket.files.find((f) => f.id === id) : undefined;
    if (file === undefined) throw new ApiError('No such file.', 404);
    return { ticket, file };
  }

  spend<T>(ticket: ChatTicket, use: () => T): T {
    this.sweep();
    if (this.spent.has(ticket.id)) throw refused('This message was already sent to the agent.');
    const used = use();
    this.spent.set(ticket.id, ticket.expiresAt);
    return used;
  }

  private sweep(): void {
    const now = this.facts.now();
    for (const [id, until] of this.spent) if (until + 60_000 < now) this.spent.delete(id);
  }
}
