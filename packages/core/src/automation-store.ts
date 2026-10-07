import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { automationDatabase, validateAutomationDirectory } from './automation-files.js';
import {
  AUTOMATION_REQUEST_MAX, AUTOMATION_RETENTION_MS, AutomationError, assertAutomationUuid,
  automationRequest, automationTerminal, parseAutomationRequest, parseAutomationResolution, parseAutomationStatus,
  type AutomationOutcome, type AutomationRequest, type AutomationResolution, type AutomationStatus,
} from './automation-types.js';
import { isRecord } from './is-record.js';

export type { AutomationOutcome, AutomationRequest, AutomationResolution, AutomationStatus, AutomationState, AutomationUuid } from './automation-types.js';

function payload<T extends { uuid: string }>(row: unknown, parse: (value: unknown) => T): T {
  try {
    if (!isRecord(row) || typeof row.payload !== 'string') throw new AutomationError('corrupt-storage');
    const value: unknown = JSON.parse(row.payload);
    const parsed = parse(value);
    if (parsed.uuid !== row.uuid) throw new AutomationError('corrupt-storage');
    return parsed;
  } catch (error) {
    throw new AutomationError('corrupt-storage', { cause: error });
  }
}

function request(row: unknown): AutomationRequest {
  const parsed = payload(row, parseAutomationRequest);
  if (!isRecord(row) || parsed.routine !== row.routine || parsed.slot !== row.slot) throw new AutomationError('corrupt-storage');
  return parsed;
}

function requests(db: DatabaseSync): AutomationRequest[] {
  const rows = db.prepare('SELECT * FROM requests ORDER BY slot, routine LIMIT 513').all();
  if (rows.length > AUTOMATION_REQUEST_MAX) throw new AutomationError('corrupt-storage');
  return rows.map(request);
}

function status(db: DatabaseSync, uuid: string): AutomationStatus | null {
  const row = db.prepare('SELECT * FROM statuses WHERE uuid = ?').get(uuid);
  return row === undefined ? null : payload(row, parseAutomationStatus);
}

function statuses(db: DatabaseSync): AutomationStatus[] {
  const rows = db.prepare('SELECT * FROM statuses LIMIT 513').all();
  if (rows.length > AUTOMATION_REQUEST_MAX) throw new AutomationError('corrupt-storage');
  return rows.map((row) => payload(row, parseAutomationStatus));
}

function resolution(row: unknown): AutomationResolution {
  const parsed = payload(row, parseAutomationResolution);
  if (!isRecord(row) || parsed.outcome !== row.outcome) throw new AutomationError('corrupt-storage');
  return parsed;
}

function resolutions(db: DatabaseSync): AutomationResolution[] {
  const rows = db.prepare('SELECT * FROM resolutions ORDER BY uuid, outcome LIMIT 1025').all();
  if (rows.length > 2 * AUTOMATION_REQUEST_MAX) throw new AutomationError('corrupt-storage');
  return rows.map(resolution);
}

function requireRequest(db: DatabaseSync, uuid: string): AutomationRequest {
  const row = db.prepare('SELECT * FROM requests WHERE uuid = ?').get(uuid);
  if (row === undefined) throw new AutomationError('unknown-request');
  return request(row);
}

function validate(db: DatabaseSync): void {
  const known = new Set(requests(db).map((entry) => entry.uuid));
  for (const entry of [...statuses(db), ...resolutions(db)]) {
    if (!known.has(entry.uuid)) throw new AutomationError('corrupt-storage');
  }
  if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new AutomationError('corrupt-storage');
}

function expiredRequests(db: DatabaseSync, cutoff: number): AutomationRequest[] {
  const saved = new Map(statuses(db).map((entry) => [entry.uuid, entry]));
  return requests(db).filter((entry) => {
    const current = saved.get(entry.uuid);
    return current !== undefined && automationTerminal(current.state) && entry.slot < cutoff && current.updatedAt < cutoff;
  });
}

export class AutomationStore {
  readonly root: string;

  constructor(root: string, private readonly now: () => number = Date.now) {
    this.root = resolve(root);
  }

  validate(): void {
    validateAutomationDirectory(this.root);
  }

  recover(): void {
    automationDatabase(this.root, true, validate, undefined, true);
  }

  submit(routine: string, slot: number, prompt: string): AutomationRequest {
    const proposed = automationRequest(routine, slot, prompt, this.now());
    return automationDatabase(this.root, true, (db) => {
      const accepted = automationRequest(routine, slot, prompt, this.now());
      const existing = requests(db);
      const found = existing.find((entry) => entry.routine === routine && entry.slot === slot);
      if (found !== undefined) {
        if (found.prompt !== prompt) throw new AutomationError('conflict');
        return found;
      }
      if (existing.length >= AUTOMATION_REQUEST_MAX) throw new AutomationError('full');
      db.prepare('INSERT INTO requests (uuid, routine, slot, payload) VALUES (?, ?, ?, ?)')
        .run(accepted.uuid, routine, slot, JSON.stringify(accepted));
      return accepted;
    }, proposed);
  }

  requests(): AutomationRequest[] {
    return automationDatabase(this.root, false, requests, []);
  }

  status(uuid: string): AutomationStatus | null {
    assertAutomationUuid(uuid);
    return automationDatabase(this.root, false, (db) => status(db, uuid), null);
  }

  statuses(): AutomationStatus[] {
    return automationDatabase(this.root, false, statuses, []);
  }

  saveStatus(value: AutomationStatus): void {
    const parsed = parseAutomationStatus(value);
    automationDatabase(this.root, true, (db) => {
      requireRequest(db, parsed.uuid);
      db.prepare('INSERT INTO statuses (uuid, payload) VALUES (?, ?) ON CONFLICT(uuid) DO UPDATE SET payload = excluded.payload')
        .run(parsed.uuid, JSON.stringify(parsed));
    }, undefined);
  }

  finish(uuid: string, token: string, outcome: AutomationOutcome): AutomationResolution {
    const proposed = parseAutomationResolution({ uuid, token, outcome, createdAt: this.now() });
    const current = this.status(uuid);
    if (current === null) throw new AutomationError('unknown-request');
    if (current.token !== token) throw new AutomationError('invalid-token');
    return automationDatabase(this.root, true, (db) => {
      requireRequest(db, uuid);
      if (status(db, uuid)?.token !== token) throw new AutomationError('invalid-token');
      const row = db.prepare('SELECT * FROM resolutions WHERE uuid = ? AND outcome = ?').get(uuid, outcome);
      if (row !== undefined) {
        const found = resolution(row);
        if (found.token !== token) throw new AutomationError('invalid-token');
        return found;
      }
      db.prepare('INSERT INTO resolutions (uuid, outcome, payload) VALUES (?, ?, ?)').run(uuid, outcome, JSON.stringify(proposed));
      return proposed;
    }, proposed);
  }

  resolutions(): AutomationResolution[] {
    return automationDatabase(this.root, false, resolutions, []);
  }

  prune(): number {
    const cutoff = this.now() - AUTOMATION_RETENTION_MS;
    if (!Number.isSafeInteger(cutoff)) throw new AutomationError('invalid-slot');
    const eligible = automationDatabase(this.root, false, (db) => expiredRequests(db, cutoff).length > 0, false);
    if (!eligible) return 0;
    return automationDatabase(this.root, true, (db) => {
      validate(db);
      const expired = expiredRequests(db, cutoff);
      for (const entry of expired) db.prepare('DELETE FROM requests WHERE uuid = ?').run(entry.uuid);
      return expired.length;
    }, 0);
  }
}
