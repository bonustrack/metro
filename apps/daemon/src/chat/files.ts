import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline, Transform, type Readable } from 'node:stream';
import { CHAT_FILE_MAX, CHAT_PARTS_MAX, fileNameOf, fileTypeOf, type ChatFile } from '@metro-labs/core/chat';
import { newId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { readFileSync, realpathSync, statSync } from '../agent-user/agent-fs.js';
import { copyIntoHome, moveHome, receiveHomeFile, removeHome, sweepHome, writeHomeText } from '../agent-user/home-fs.js';
import { capFolder } from './files-cap.js';

export const CHAT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const SIDECAR_MAX = 4096;
const PATH_MAX = 4096;
const DRAIN_MAX = 2 * CHAT_FILE_MAX;
const EMPTY_FOLDER_MINUTES = 10;
const NO_HOME = 'This box has no agent user to keep chat files, so nothing is kept. Reinstall Metro on this box, then try again.';
const SIDECAR = '.meta.json';
const EXT_RE = /^[a-z0-9]{1,10}$/;

export interface MissingFile {
  name: string;
  type: string;
  size: number;
}

export interface TurnFile extends MissingFile {
  path: string;
}

export function extOf(name: string): string {
  const at = name.lastIndexOf('.');
  const ext = at === -1 ? '' : name.slice(at + 1).toLowerCase();
  return EXT_RE.test(ext) ? ext : '';
}

interface Sidecar {
  name: string;
  type: string;
  size: number;
  chat: string;
  message: string;
  at: number;
}

export interface StoredFile extends Sidecar {
  path: string;
}

interface Shared {
  path: string;
  name: string;
  type: string;
}

export interface ShareInput extends Shared {
  chat: string;
  message: string;
}

const idOf = (value: unknown): string | null => (typeof value === 'string' && CHAT_ID_RE.test(value) ? value : null);

function sidecarOf(raw: unknown): Sidecar | null {
  if (!isRecord(raw)) return null;
  const name = fileNameOf(raw.name);
  const chat = idOf(raw.chat);
  const message = idOf(raw.message);
  const { size, at } = raw;
  if (name === null || chat === null || message === null || typeof size !== 'number' || typeof at !== 'number') return null;
  return { name, type: fileTypeOf(raw.type), size, chat, message, at };
}

const plainPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= PATH_MAX && isAbsolute(value) && resolve(value) === value && !/[\0\n]/.test(value);

export const shareIndexOf = (value: Record<string, unknown>): number | null =>
  typeof value.n === 'number' && Number.isInteger(value.n) && value.n >= 0 && value.n < CHAT_PARTS_MAX ? value.n : null;

export function shareOf(value: Record<string, unknown>): Shared | null {
  const { path } = value;
  if (!plainPath(path)) return null;
  return { path, name: fileNameOf(value.name) ?? fileNameOf(basename(path)) ?? 'file', type: fileTypeOf(value.type) };
}

function exactly(body: Readable, size: number): Readable {
  let total = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _enc, done): void {
      total += chunk.length;
      if (total > DRAIN_MAX) done(new ApiError('This file is larger than metro.box said it would be.', 400));
      else if (total > size) done();
      else done(null, chunk);
    },
    flush(done): void {
      if (total === size) done();
      else done(new ApiError(total > size ? 'This file is larger than metro.box said it would be.' : 'This file ended before all of it arrived.', 400));
    },
  });
  return pipeline(body, guard, (err) => {
    if (err) log.debug({ err: errMsg(err) }, 'chat: a file upload ended early');
  });
}

export class ChatFiles {
  constructor(
    private readonly root: () => string | null,
    private readonly now: () => number = Date.now,
  ) {}

  private base(): string {
    const root = this.root();
    if (root === null) throw new ApiError(NO_HOME, 503);
    return root;
  }

  private nameIn(chat: string, name: string): string {
    if (!CHAT_ID_RE.test(chat)) throw new ApiError('No such file.', 404);
    return join(this.base(), chat, name);
  }

  private pathOf(chat: string, id: string, name: string): string {
    if (!CHAT_ID_RE.test(id)) throw new ApiError('No such file.', 404);
    const ext = extOf(name);
    return this.nameIn(chat, ext === '' ? id : `${id}.${ext}`);
  }

  private sidecarOf(chat: string, id: string): string {
    if (!CHAT_ID_RE.test(id)) throw new ApiError('No such file.', 404);
    return this.nameIn(chat, `${id}${SIDECAR}`);
  }

  private keep(chat: string, id: string, meta: Sidecar): void {
    writeHomeText(this.sidecarOf(chat, id), JSON.stringify(meta), 0o600);
  }

  private inPlace(path: string): boolean {
    return realpathSync(path) === join(realpathSync(this.base()), relative(this.base(), path));
  }

  async receive(chat: string, message: string, file: ChatFile, body: Readable): Promise<void> {
    const path = this.pathOf(chat, file.id, file.name);
    const part = `${path}.up-${randomBytes(6).toString('hex')}`;
    try {
      await receiveHomeFile(part, exactly(body, file.size), 0o600);
    } catch (err) {
      removeHome(part);
      throw err;
    }
    moveHome(part, path);
    this.keep(chat, file.id, { name: file.name, type: file.type, size: file.size, chat, message, at: this.now() });
  }

  private metaOf(chat: string, side: string): Sidecar | null {
    if (!this.inPlace(side) || statSync(side).size > SIDECAR_MAX) return null;
    const meta = sidecarOf(JSON.parse(readFileSync(side, 'utf8')));
    return meta?.chat === chat ? meta : null;
  }

  find(chat: string, id: string): StoredFile | null {
    const side = this.sidecarOf(chat, id);
    try {
      const meta = this.metaOf(chat, side);
      if (meta === null) return null;
      const path = this.pathOf(chat, id, meta.name);
      const stat = statSync(path);
      return this.inPlace(path) && stat.isFile() ? { ...meta, size: stat.size, path } : null;
    } catch {
      return null;
    }
  }

  ready(chat: string, message: string, files: readonly ChatFile[]): { files: TurnFile[]; missing: MissingFile[] } {
    const arrived: TurnFile[] = [];
    const missing: MissingFile[] = [];
    for (const file of files) {
      const stored = this.find(chat, file.id);
      const { name, type, size } = file;
      if (stored?.message === message && stored.size === size && stored.path === this.pathOf(chat, file.id, name)) arrived.push({ path: stored.path, name, type, size });
      else missing.push({ name, type, size });
    }
    return { files: arrived, missing };
  }

  async share(input: ShareInput): Promise<ChatFile> {
    const root = this.base();
    const id = newId();
    const path = this.pathOf(input.chat, id, input.name);
    const size = await copyIntoHome(input.path, path, realpathSync(dirname(root)), CHAT_FILE_MAX);
    this.keep(input.chat, id, { name: input.name, type: input.type, size, chat: input.chat, message: input.message, at: this.now() });
    return { id, name: input.name, type: input.type, size };
  }

  async sweep(ttlMs: number, maxBytes: number): Promise<number> {
    const root = this.root();
    if (root === null) return 0;
    const old = await sweepHome(root, Math.ceil(ttlMs / 60_000), EMPTY_FOLDER_MINUTES);
    return old + capFolder(root, maxBytes);
  }
}

export function startChatFileReaper(files: ChatFiles, ttlMs: () => number, maxBytes: () => number, everyMs: number): void {
  const run = (): void => {
    files
      .sweep(ttlMs(), maxBytes())
      .then((removed) => {
        if (removed > 0) log.info({ removed }, 'chat: old chat files were removed');
      })
      .catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, 'chat: old chat files could not be removed');
      });
  };
  run();
  setInterval(run, everyMs).unref?.();
}
