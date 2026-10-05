import { jidNormalizedUser, type WAMessageKey } from 'baileys';
import { TrainError } from '@metro-labs/core/train-error';
import { HISTORY_LIMITS } from './history-types.js';

export const normalizedJid = (jid: string): string => jidNormalizedUser(jid);
const phone = (jid: string): boolean => jid.endsWith('@s.whatsapp.net');
const lid = (jid: string): boolean => jid.endsWith('@lid');
const identity = (v: unknown): v is string => typeof v === 'string' && v.length <= 256 && (phone(v) || lid(v));
const invalid = (): never => { throw new TrainError('whatsapp_history_invalid', 'WhatsApp history aliases are invalid; refusing to discard replay protection'); };

export class HistoryIdentity {
  private readonly groups = new Map<string, readonly string[]>();

  constructor(value: unknown = []) {
    if (!Array.isArray(value)) return invalid();
    for (const group of value) this.restore(group);
    if (this.groups.size > HISTORY_LIMITS.aliases) return invalid();
  }

  private restore(group: unknown): void {
    if (!Array.isArray(group) || !group.every(identity)) return invalid();
    const pn = group.find(phone);
    const alternate = group.find(lid);
    if (!pn || !alternate) return invalid();
    for (const jid of group) this.alias(jid, phone(jid) ? alternate : pn);
  }

  get size(): number { return this.groups.size; }

  known(jid: string): readonly string[] {
    const normalized = normalizedJid(jid);
    return this.groups.get(normalized) ?? [normalized];
  }

  canonical(jid: string): string { return this.known(jid)[0] ?? normalizedJid(jid); }

  same(left: string, right: string): boolean { return this.canonical(left) === this.canonical(right); }

  alias(left: string, right: string): boolean {
    if (!identity(left) || !identity(right)) return false;
    const a = normalizedJid(left);
    const b = normalizedJid(right);
    if (phone(a) === phone(b) || this.same(a, b)) return false;
    const group = [...new Set([...this.known(a), ...this.known(b)])].sort();
    for (const jid of group) this.groups.set(jid, group);
    return true;
  }

  remember(key: WAMessageKey): boolean {
    const chat = this.alias(key.remoteJid ?? '', key.remoteJidAlt ?? '');
    const sender = this.alias(key.participant ?? '', key.participantAlt ?? '');
    return chat || sender;
  }

  clear(): void { this.groups.clear(); }

  serialize(): readonly (readonly string[])[] { return [...new Set(this.groups.values())]; }
}
