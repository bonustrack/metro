import { errMsg, log } from '@metro-labs/core/log';
import { isPnUser, isLidUser, makeEventBuffer, processSyncAction, type BaileysEventEmitter, type Contact } from 'baileys';
import type { History } from './history.js';
import { baileysLogger } from './logger.js';

interface AppStateHooks {
  history: History;
  current(): boolean;
}

export function supportsHistoryDeletion(processAction = processSyncAction): boolean {
  const ev = makeEventBuffer(baileysLogger('history-support'));
  const id = 'history-support@g.us';
  const messageRange = { lastMessageTimestamp: 1 };
  let received = 0;
  ev.on('chats.clear', (event) => {
    if (event.id === id && event.messageRange === messageRange) received++;
  });
  try {
    for (const initial of [false, true]) {
      for (const type of ['clearChat', 'deleteChat']) {
        const value = type === 'clearChat' ? { clearChatAction: { messageRange } } : { deleteChatAction: { messageRange } };
        const before = received;
        processAction({ index: [type, id], syncAction: { value } }, ev, { id }, initial ? { accountSettings: { unarchiveChats: false } } : undefined);
        if (received !== before + 1) return false;
      }
    }
    return true;
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'whatsapp: local history deletion support check failed');
    return false;
  }
}

export function noteHistoryContact(history: History, contact: Partial<Contact>): void {
  const pn = contact.phoneNumber ?? (isPnUser(contact.id) ? contact.id : undefined);
  const lid = contact.lid ?? (isLidUser(contact.id) ? contact.id : undefined);
  if (pn && lid) history.alias(pn, lid);
}

export function bindAppState(ev: BaileysEventEmitter, hooks: AppStateHooks): void {
  ev.on('lid-mapping.update', ({ pn, lid }) => {
    if (hooks.current()) hooks.history.alias(pn, lid);
  });
  ev.on('chats.clear', ({ id, messageRange }) => {
    if (!hooks.current()) return;
    hooks.history.clearRange(id, messageRange ?? {});
  });
}
