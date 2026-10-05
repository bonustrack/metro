import type makeWASocket from 'baileys';
import type { fetchLatestWaWebVersion, WAMessage } from 'baileys';
import type { MemberList } from '@metro-labs/core/stations/types';
import type { ProfileChange } from '@metro-labs/core/stations/profile';
import type { SenderProfile } from '@metro-labs/core/stations/sender-profile';
import type { WhatsAppAccount } from './types.js';
import type { InboundMessage, ReactionInput } from './format.js';
import type { SenderFound } from './resolve.js';
import type { HistoryOptions, HistoryPage } from './history.js';

export interface InboundHandlers {
  onMessage(m: InboundMessage, raw: WAMessage): void;
  onReaction(r: ReactionInput): void;
}

export interface WAMedia {
  kind: string;
  path: string;
  mime: string;
  name: string;
  caption?: string;
}

export interface WAClient {
  account: WhatsAppAccount;
  self(): string | null;
  start(handlers: InboundHandlers): Promise<void>;
  read(jid: string, options?: HistoryOptions): Promise<HistoryPage>;
  listMembers(jid: string, limit?: number): Promise<MemberList>;
  sendText(jid: string, text: string, quotedId?: string): Promise<string>;
  sendMedia(jid: string, media: WAMedia, quotedId?: string): Promise<string>;
  sendReaction(jid: string, messageId: string, emoji: string): Promise<void>;
  showTyping(jid: string): Promise<void>;
  editMessage(jid: string, messageId: string, text: string): Promise<void>;
  deleteMessage(jid: string, messageId: string): Promise<void>;
  reuploadMedia(m: WAMessage): Promise<WAMessage>;
  lookupSender(number: string): Promise<SenderFound>;
  setProfile(change: ProfileChange): Promise<void>;
  senderProfile(jid: string): Promise<SenderProfile | null>;
  disconnect(): Promise<void>;
}

export interface ClientRuntime {
  makeSocket: typeof makeWASocket;
  fetchVersion: typeof fetchLatestWaWebVersion;
}
