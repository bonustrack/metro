import { readFileSync, rmSync, statSync } from 'node:fs';
import { clearHistoryTemps, historyFiles } from './history-files.js';
import { writeSecure } from '@metro-labs/core/secure-fs';
import { isRecord } from '@metro-labs/core/is-record';
import { TrainError } from '@metro-labs/core/train-error';
import type { proto, WAMessageKey } from 'baileys';
import { HistoryIdentity, normalizedJid } from './history-identity.js';
import type { WAMediaRef } from './media.js';
import { historyJid, historyKey, clipped, numberOf } from './history-message.js';
import { HISTORY_AGE_MS, HISTORY_LIMITS, newestFirst, slotOf, type StoredRow } from './history-types.js';

export { historyFiles } from './history-files.js';

const validTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < 8.64e15;
const invalid = (): never => { throw new TrainError('whatsapp_history_invalid', 'WhatsApp local history is invalid; refusing to discard replay protection'); };

function mediaKind(value: unknown): value is WAMediaRef['kind'] {
  return value === 'image' || value === 'video' || value === 'audio' || value === 'voice' || value === 'document' || value === 'sticker';
}

function mediaFromDisk(value: unknown): WAMediaRef {
  if (!isRecord(value)) return invalid();
  const kind = value.kind;
  if (!mediaKind(kind)) return invalid();
  return {
    kind,
    ...(typeof value.mime === 'string' ? { mime: clipped(value.mime, 128) } : {}),
    ...(typeof value.name === 'string' ? { name: clipped(value.name, 256) } : {}),
    ...(validTime(value.bytes) ? { bytes: value.bytes } : {}),
  };
}

function optionalTime(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return validTime(value) ? value : invalid();
}

function metadataFromDisk(value: Record<string, unknown>): Omit<StoredRow, 'key' | 'at' | 'text'> {
  const expiresAt = optionalTime(value.expiresAt);
  const editedAt = optionalTime(value.editedAt);
  const media = value.attachments;
  if (media !== undefined && (!Array.isArray(media) || media.length > 1)) return invalid();
  return {
    ...(typeof value.senderJid === 'string' && value.senderJid.length <= 256 ? { senderJid: value.senderJid } : {}),
    ...(value.truncated === true ? { truncated: true } : {}),
    ...(Array.isArray(media) ? { attachments: media.map(mediaFromDisk) } : {}),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(editedAt === undefined ? {} : { editedAt }),
  };
}

function rowFromDisk(value: unknown): StoredRow {
  if (!isRecord(value)) return invalid();
  const key = historyKey(value.key);
  if (!key || key.isViewOnce || !validTime(value.at) || typeof value.text !== 'string') return invalid();
  return { key, at: value.at, text: clipped(value.text, HISTORY_LIMITS.textBytes), ...metadataFromDisk(value) };
}

function timesFromDisk(value: unknown): Map<string, number> {
  if (!Array.isArray(value)) return invalid();
  const result = new Map<string, number>();
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || item[0].length > 4096 || !validTime(item[1])) return invalid();
    result.set(item[0], item[1]);
  }
  return result;
}

function rangeKey(jid: string, key: WAMessageKey | null | undefined): WAMessageKey | undefined {
  return historyKey({ ...key, remoteJid: key?.remoteJid ?? jid });
}

function flagFromDisk(value: unknown): boolean {
  if (value === undefined) return false;
  return typeof value === 'boolean' ? value : invalid();
}

function unavailableFromDisk(value: unknown = []): Set<string> {
  if (!Array.isArray(value) || value.length > HISTORY_LIMITS.unavailableChats) return invalid();
  const jids: string[] = [];
  for (const jid of value) {
    if (typeof jid !== 'string' || !historyJid(jid)) return invalid();
    jids.push(normalizedJid(jid));
  }
  return new Set(jids);
}

function readState(path: string): unknown {
  try {
    if (statSync(path).size > HISTORY_LIMITS.bytes) return invalid();
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    if (isRecord(err) && err.code === 'ENOENT') return undefined;
    throw err;
  }
}

export class HistoryState {
  readonly rows = new Map<string, StoredRow>();
  private tombstones = new Map<string, number>();
  private chatFloors = new Map<string, number>();
  private floor: number;
  private written = '';
  private invalidated = false;
  private readonly path: string;
  private identities = new HistoryIdentity();
  private unavailableChats = new Set<string>();
  private unavailableOverflow = false;

  constructor(private readonly accountId: string) {
    this.path = historyFiles.path(accountId);
    clearHistoryTemps(this.path);
    this.floor = Date.now() - HISTORY_AGE_MS;
    const raw = readState(this.path);
    if (raw === undefined) return;
    if (!isRecord(raw) || raw.version !== 1 || raw.accountId !== accountId || !validTime(raw.floor) || !Array.isArray(raw.rows)) return invalid();
    const invalidated = flagFromDisk(raw.invalidated);
    this.floor = Math.max(this.floor, raw.floor, invalidated ? Date.now() : 0);
    this.identities = new HistoryIdentity(raw.aliases);
    for (const item of raw.rows) {
      const row = rowFromDisk(item);
      this.identities.remember(row.key);
      this.put(row);
    }
    this.tombstones = timesFromDisk(raw.tombstones);
    this.chatFloors = timesFromDisk(raw.chatFloors);
    this.unavailableChats = unavailableFromDisk(raw.unavailableChats);
    this.unavailableOverflow = flagFromDisk(raw.unavailableOverflow);
    this.aliasesChanged(Date.now());
    if (invalidated) this.flush();
  }

  invalidate(now: number): void {
    this.invalidated = true;
    this.floor = Math.max(this.floor, now);
    this.rows.clear();
    this.tombstones.clear();
    this.chatFloors.clear();
    this.unavailableChats.clear();
    this.unavailableOverflow = false;
    this.identities.clear();
    this.flush();
  }

  alias(pn: string, lid: string, now: number): void {
    if (this.identities.alias(pn, lid)) this.aliasesChanged(now);
  }

  observe(key: WAMessageKey, now: number): void {
    if (this.identities.remember(key)) this.aliasesChanged(now);
  }

  same(left: string, right: string): boolean { return this.identities.same(left, right); }

  assertReadable(jid: string): void {
    if (this.unavailableOverflow || this.identities.known(jid).some((alias) => this.unavailableChats.has(alias)))
      throw new TrainError('whatsapp_history_unavailable', 'WhatsApp local history is unavailable because a chat deletion had no safe message range');
  }

  private unavailable(jid: string): void {
    if (this.unavailableOverflow) return;
    this.unavailableChats.add(this.identities.canonical(jid));
    if (this.unavailableChats.size > HISTORY_LIMITS.unavailableChats) {
      this.unavailableOverflow = true;
      this.unavailableChats.clear();
    }
  }

  private forgetAliases(): void {
    this.unavailableOverflow ||= this.unavailableChats.size > 0;
    this.identities.clear();
  }

  private aliasesChanged(now: number): void {
    if (this.identities.size > HISTORY_LIMITS.aliases) {
      this.floor = Math.max(this.floor, now);
      this.forgetAliases();
    }
    this.sweep(now);
    const seen = new Map<string, StoredRow>();
    for (const row of this.rows.values()) {
      const id = slotOf({ ...row.key, remoteJid: this.identities.canonical(row.key.remoteJid ?? '') });
      const old = seen.get(id);
      if (!old) { seen.set(id, row); continue; }
      seen.set(id, this.merge(row, old));
    }
  }

  private merge(row: StoredRow, old: StoredRow): StoredRow {
    const kept = (row.editedAt ?? 0) > (old.editedAt ?? 0) ? row : old;
    const dropped = kept === row ? old : row;
    if (dropped.expiresAt !== undefined) kept.expiresAt = Math.min(kept.expiresAt ?? Infinity, dropped.expiresAt);
    this.rows.delete(this.slot(dropped.key));
    return kept;
  }

  private slot(key: WAMessageKey): string {
    return slotOf({ ...key, remoteJid: normalizedJid(key.remoteJid ?? '') });
  }

  private slots(key: WAMessageKey): string[] {
    return this.identities.known(key.remoteJid ?? '').map((jid) => slotOf({ remoteJid: jid, id: key.id }));
  }

  get(key: WAMessageKey): StoredRow | undefined {
    for (const slot of this.slots(key)) {
      const row = this.rows.get(slot);
      if (row) return row;
    }
    return undefined;
  }

  put(row: StoredRow): void { this.rows.set(this.slot(row.key), row); }

  after(jid: string): number {
    return Math.max(this.floor, ...this.identities.known(jid).map((alias) => this.chatFloors.get(alias) ?? 0));
  }

  outside(key: WAMessageKey, at: number, now: number): boolean {
    return at <= Math.max(now - HISTORY_AGE_MS, this.after(key.remoteJid ?? ''), this.after(key.remoteJidAlt ?? ''));
  }

  blocked(key: WAMessageKey, at: number): boolean {
    return this.slots(key).some((slot) => this.tombstones.has(slot)) || at <= this.after(key.remoteJid ?? '');
  }

  remove(key: WAMessageKey, now: number, at?: number): void {
    const clean = historyKey(key);
    if (!clean) return;
    const originalAt = this.get(clean)?.at ?? at;
    if (originalAt !== undefined && this.outside(clean, originalAt, now)) return;
    this.observe(clean, now);
    let horizon = now;
    for (const slot of this.slots(clean)) {
      horizon = Math.max(horizon, this.rows.get(slot)?.at ?? 0, this.tombstones.get(slot) ?? 0);
      this.rows.delete(slot);
      this.tombstones.delete(slot);
    }
    this.tombstones.set(this.slot(clean), horizon);
  }

  clear(jid: string, cutoff: number): void {
    if (!historyJid(jid)) return;
    this.chatFloors.set(this.identities.canonical(jid), Math.max(cutoff, this.after(jid)));
    for (const [slot, row] of this.rows)
      if (this.same(row.key.remoteJid ?? '', jid) && row.at <= cutoff) this.rows.delete(slot);
  }

  clearRange(jid: string, range: proto.SyncActionValue.ISyncActionMessageRange, now: number): void {
    if (!historyJid(jid)) return;
    const cutoff = (numberOf(range.lastMessageTimestamp) ?? 0) * 1000;
    let usable = cutoff > 0 && cutoff <= now;
    if (usable) this.clear(jid, cutoff);
    for (const item of range.messages ?? []) {
      const key = rangeKey(jid, item.key);
      const cleared = this.clearKey(jid, key, numberOf(item.timestamp), now);
      usable ||= cleared;
    }
    if (!usable) this.unavailable(jid);
  }

  private clearKey(jid: string, key: WAMessageKey | undefined, at: number | undefined, now: number): boolean {
    if (!key || (at !== undefined && at * 1000 > now)) return false;
    if (!this.same(key.remoteJid ?? '', jid) && !this.same(key.remoteJidAlt ?? '', jid)) return false;
    this.observe(key, now);
    this.remove(key, now, at === undefined ? undefined : at * 1000);
    return true;
  }

  private sweep(now: number): void {
    this.floor = Math.max(this.floor, now - HISTORY_AGE_MS);
    for (const [slot, row] of this.rows) {
      if (this.blocked(row.key, row.at)) this.rows.delete(slot);
      else if (row.expiresAt !== undefined && row.expiresAt <= now) this.remove(row.key, now);
    }
    for (const map of [this.tombstones, this.chatFloors])
      for (const [key, cutoff] of map) if (cutoff <= this.floor) map.delete(key);
  }

  private trimMarkers(map: Map<string, number>, max: number): void {
    if (map.size <= max) return;
    const sorted = [...map.entries()].sort((a, b) => a[1] - b[1]);
    for (const [key, cutoff] of sorted.slice(0, map.size - max)) {
      this.floor = Math.max(this.floor, cutoff);
      map.delete(key);
    }
  }

  prune(now: number): void {
    this.sweep(now);
    const sorted = [...this.rows.values()].sort(newestFirst);
    const counts = new Map<string, number>();
    for (const [index, row] of sorted.entries()) {
      const jid = this.identities.canonical(row.key.remoteJid ?? '');
      const count = (counts.get(jid) ?? 0) + 1;
      counts.set(jid, count);
      if (count > HISTORY_LIMITS.rowsPerChat) this.chatFloors.set(jid, Math.max(this.after(jid), row.at));
      if (index >= HISTORY_LIMITS.rows) this.floor = Math.max(this.floor, row.at);
    }
    this.trimMarkers(this.chatFloors, HISTORY_LIMITS.chatFloors);
    this.trimMarkers(this.tombstones, HISTORY_LIMITS.tombstones);
    this.sweep(now);
    this.trimBytes(now);
  }

  private serialize(): string {
    return JSON.stringify({
      version: 1, accountId: this.accountId, floor: this.floor,
      rows: [...this.rows.values()], aliases: this.identities.serialize(),
      ...(this.invalidated ? { invalidated: true } : {}),
      unavailableChats: [...this.unavailableChats], unavailableOverflow: this.unavailableOverflow,
      tombstones: [...this.tombstones], chatFloors: [...this.chatFloors],
    });
  }

  private trimBytes(now: number): void {
    let bytes = Buffer.byteLength(this.serialize());
    if (bytes <= HISTORY_LIMITS.bytes) return;
    for (const row of [...this.rows.values()].sort(newestFirst).reverse()) {
      this.rows.delete(this.slot(row.key));
      this.floor = Math.max(this.floor, row.at);
      bytes -= Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes < HISTORY_LIMITS.bytes - 1024) break;
    }
    this.sweep(now);
    if (Buffer.byteLength(this.serialize()) > HISTORY_LIMITS.bytes) {
      this.floor = Math.max(now, this.floor, ...this.tombstones.values(), ...this.chatFloors.values());
      this.forgetAliases();
      this.sweep(now);
    }
  }

  flush(): void {
    this.prune(Date.now());
    const body = this.serialize();
    if (body === this.written) return;
    try {
      writeSecure(this.path, body);
      this.written = body;
    } finally {
      rmSync(`${this.path}.tmp-${process.pid}`, { force: true });
    }
  }
}
