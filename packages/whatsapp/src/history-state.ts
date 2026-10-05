import { readFileSync, rmSync, statSync } from 'node:fs';
import { clearHistoryTemps, historyFiles } from './history-files.js';
import { writeSecure } from '@metro-labs/core/secure-fs';
import { isRecord } from '@metro-labs/core/is-record';
import { TrainError } from '@metro-labs/core/train-error';
import type { WAMessageKey } from 'baileys';
import type { WAMediaRef } from './media.js';
import { historyJid, historyKey, clipped } from './history-message.js';
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
  private readonly path: string;

  constructor(private readonly accountId: string) {
    this.path = historyFiles.path(accountId);
    clearHistoryTemps(this.path);
    this.floor = Date.now() - HISTORY_AGE_MS;
    const raw = readState(this.path);
    if (raw === undefined) return;
    if (!isRecord(raw) || raw.version !== 1 || raw.accountId !== accountId || !validTime(raw.floor) || !Array.isArray(raw.rows)) return invalid();
    this.floor = Math.max(this.floor, raw.floor);
    for (const item of raw.rows) {
      const row = rowFromDisk(item);
      this.rows.set(slotOf(row.key), row);
    }
    this.tombstones = timesFromDisk(raw.tombstones);
    this.chatFloors = timesFromDisk(raw.chatFloors);
  }

  after(jid: string): number {
    return Math.max(this.floor, this.chatFloors.get(jid) ?? 0);
  }

  blocked(key: WAMessageKey, at: number): boolean {
    return this.tombstones.has(slotOf(key)) || at <= this.after(key.remoteJid ?? '');
  }

  remove(key: WAMessageKey, now: number): void {
    const clean = historyKey(key);
    if (!clean) return;
    const slot = slotOf(clean);
    const horizon = Math.max(now, this.rows.get(slot)?.at ?? 0, this.tombstones.get(slot) ?? 0);
    this.rows.delete(slot);
    this.tombstones.set(slot, horizon);
  }

  clear(jid: string, now: number): void {
    if (!historyJid(jid)) return;
    this.chatFloors.set(jid, Math.max(now, this.after(jid)));
    for (const [slot, row] of this.rows) {
      if (row.key.remoteJid !== jid) continue;
      this.chatFloors.set(jid, Math.max(row.at, this.after(jid)));
      this.rows.delete(slot);
    }
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
      const jid = row.key.remoteJid ?? '';
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
      rows: [...this.rows.values()],
      tombstones: [...this.tombstones], chatFloors: [...this.chatFloors],
    });
  }

  private trimBytes(now: number): void {
    let bytes = Buffer.byteLength(this.serialize());
    if (bytes <= HISTORY_LIMITS.bytes) return;
    for (const row of [...this.rows.values()].sort(newestFirst).reverse()) {
      this.rows.delete(slotOf(row.key));
      this.floor = Math.max(this.floor, row.at);
      bytes -= Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes < HISTORY_LIMITS.bytes - 1024) break;
    }
    this.sweep(now);
    if (Buffer.byteLength(this.serialize()) > HISTORY_LIMITS.bytes) {
      this.floor = Math.max(now, this.floor, ...this.tombstones.values(), ...this.chatFloors.values());
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
