import { randomUUID } from 'node:crypto';
import fs, { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, type Stats } from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AutomationError } from './automation-types.js';
import { isRecord } from './is-record.js';

const FILE = 'automation.sqlite';
const SCHEMA = `
CREATE TABLE requests (
  uuid TEXT PRIMARY KEY NOT NULL,
  routine TEXT NOT NULL,
  slot INTEGER NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (routine, slot)
);
CREATE TABLE statuses (
  uuid TEXT PRIMARY KEY NOT NULL REFERENCES requests(uuid) ON DELETE CASCADE,
  payload TEXT NOT NULL
);
CREATE TABLE resolutions (
  uuid TEXT NOT NULL REFERENCES requests(uuid) ON DELETE CASCADE,
  outcome TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (uuid, outcome)
);
PRAGMA user_version = 1;
`;

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function metadata(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
}

function uid(): number {
  if (process.getuid === undefined) throw new AutomationError('unsafe-storage');
  return process.getuid();
}

function checkDirectory(info: Stats, privateDirectory: boolean): void {
  if (!info.isDirectory() || info.isSymbolicLink()) throw new AutomationError('unsafe-storage');
  if (privateDirectory) {
    if (info.uid !== uid() || (info.mode & 0o7777) !== 0o700) throw new AutomationError('unsafe-storage');
    return;
  }
  if (info.uid !== uid() && info.uid !== 0) throw new AutomationError('unsafe-storage');
  if ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) throw new AutomationError('unsafe-storage');
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function directory(root: string, create: boolean): boolean {
  let current = parse(root).root;
  const base = metadata(current);
  if (base === null) throw new AutomationError('unsafe-storage');
  checkDirectory(base, current === root);
  for (const component of root.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    let info = metadata(current);
    if (info === null) {
      if (!create) return false;
      try {
        mkdirSync(current, { mode: 0o700 });
        syncDirectory(dirname(current));
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
      }
      info = metadata(current);
    }
    if (info === null) throw new AutomationError('unsafe-storage');
    checkDirectory(info, current === root);
  }
  return true;
}

function checkFile(info: Stats, singleLink = false): void {
  if (!info.isFile() || info.uid !== uid() || (info.mode & 0o7777) !== 0o600 || (singleLink && info.nlink !== 1)) throw new AutomationError('unsafe-storage');
}

function companions(path: string): void {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const info = metadata(`${path}${suffix}`);
    if (info !== null) checkFile(info, true);
  }
}

function sameFile(path: string, opened: Stats): void {
  const current = metadata(path);
  if (current === null || current.dev !== opened.dev || current.ino !== opened.ino) throw new AutomationError('unsafe-storage');
  checkFile(current);
}

function initializeFile(path: string, fd: number): void {
  const opened = fstatSync(fd);
  checkFile(opened);
  const db = new DatabaseSync(path);
  try {
    sameFile(path, opened);
    db.exec('PRAGMA trusted_schema = OFF');
    transaction(db, (database) => { database.exec(SCHEMA); });
  } finally {
    db.close();
  }
  fs.fsyncSync(fd);
}

function createFile(path: string): void {
  if (metadata(path) !== null) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    initializeFile(temporary, fd);
    try {
      fs.linkSync(temporary, path);
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
  } finally {
    closeSync(fd);
    fs.unlinkSync(temporary);
  }
  syncDirectory(dirname(path));
}

function transaction<T>(db: DatabaseSync, action: (database: DatabaseSync) => T): T {
  db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
  try {
    const result = action(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function useDatabase<T>(path: string, writable: boolean, action: (database: DatabaseSync) => T): T {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let db: DatabaseSync | undefined;
  try {
    const opened = fstatSync(fd);
    checkFile(opened);
    companions(path);
    db = new DatabaseSync(path, { readOnly: !writable });
    sameFile(path, opened);
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF');
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new AutomationError('corrupt-storage');
    if (writable) return transaction(db, action);
    if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw new AutomationError('corrupt-storage');
    db.exec('BEGIN');
    try {
      return action(db);
    } finally {
      db.exec('ROLLBACK');
    }
  } finally {
    db?.close();
    closeSync(fd);
  }
}

function databasePath(root: string, writable: boolean, existingOnly: boolean): string | null {
  const create = writable && !existingOnly;
  const absolute = resolve(root);
  if (!directory(absolute, create)) return null;
  const path = join(absolute, FILE);
  companions(path);
  if (create) createFile(path);
  const info = metadata(path);
  if (info === null) {
    if (create) throw new AutomationError('storage-unavailable');
    return null;
  }
  checkFile(info);
  return path;
}

export function validateAutomationDirectory(root: string): void {
  try {
    databasePath(root, false, false);
  } catch (error) {
    if (error instanceof AutomationError) throw error;
    throw new AutomationError('storage-unavailable', { cause: error });
  }
}

export function automationDatabase<T>(root: string, writable: boolean, action: (database: DatabaseSync) => T, missing: T, existingOnly = false): T {
  try {
    const path = databasePath(root, writable, existingOnly);
    if (path === null) return missing;
    const result = useDatabase(path, writable, action);
    if (writable) {
      companions(path);
      syncDirectory(dirname(path));
    }
    return result;
  } catch (error) {
    if (error instanceof AutomationError) throw error;
    throw new AutomationError('storage-unavailable', { cause: error });
  }
}
