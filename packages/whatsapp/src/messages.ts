import { jidNormalizedUser, type WASocket } from 'baileys';
import type { InboundHandlers } from './client-types.js';
import type { History } from './history.js';
import type { KeyCache } from './keys.js';
import { noteContact, type NameBook } from './names.js';
import { toInbound, toReaction, type SelfRef } from './parse.js';

interface MessageHooks {
  accountId: string;
  keys: KeyCache;
  names: NameBook;
  history: History;
  current(): boolean;
  handlers(): InboundHandlers | undefined;
  self(): SelfRef;
}

export function bindMessages(sock: Pick<WASocket, 'ev' | 'user'>, hooks: MessageHooks): void {
  const selfJid = (): string | undefined => sock.user?.id ? jidNormalizedUser(sock.user.id) : undefined;
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (!hooks.current()) return;
    for (const m of messages) hooks.keys.remember(m.key);
    hooks.history.ingest(messages, selfJid());
    const handlers = hooks.handlers();
    if (type !== 'notify' || !handlers) return;
    for (const m of messages) {
      if (m.key.fromMe) continue;
      const inbound = toInbound(hooks.accountId, m, hooks.self());
      if (!inbound) continue;
      hooks.names.note(inbound.senderJid, inbound.pushName);
      handlers.onMessage(inbound, m);
    }
  });
  sock.ev.on('contacts.upsert', (contacts) => {
    if (hooks.current()) for (const c of contacts) noteContact(hooks.names, c);
  });
  sock.ev.on('contacts.update', (contacts) => {
    if (hooks.current()) for (const c of contacts) noteContact(hooks.names, c);
  });
  sock.ev.on('messaging-history.set', ({ contacts, messages }) => {
    if (!hooks.current()) return;
    for (const c of contacts) noteContact(hooks.names, c);
    for (const m of messages) {
      hooks.keys.remember(m.key);
      if (m.key.fromMe !== true) hooks.names.note(m.key.participant ?? m.key.remoteJid, m.pushName);
    }
    hooks.history.ingest(messages, selfJid());
  });
  sock.ev.on('messages.update', (updates) => {
    if (hooks.current()) hooks.history.update(updates, selfJid());
  });
  sock.ev.on('messages.delete', (event) => {
    if (hooks.current()) hooks.history.deleteMessages(event);
  });
  sock.ev.on('chats.delete', (jids) => {
    if (hooks.current()) for (const jid of jids) hooks.history.deleteMessages({ jid, all: true });
  });
  sock.ev.on('messages.reaction', (events) => {
    if (!hooks.current()) return;
    const handlers = hooks.handlers();
    if (!handlers) return;
    for (const event of events) {
      const reaction = toReaction(hooks.accountId, event);
      if (reaction) handlers.onReaction(reaction);
    }
  });
}
