import { useSyncExternalStore } from 'react';
import type { ChatFile } from '@metro-labs/core/chat';
import type { ChatFileBody } from '@metro-labs/client/api/chat-files';
import type { HeldFile } from './chat-files.js';

export type UploadState = 'waiting' | 'sending' | 'sent' | 'failed' | 'unsent';

interface Held {
  body: (() => Promise<ChatFileBody>) | null;
  state: UploadState;
}

type Uploads = ReadonlyMap<string, Held>;

const held = new Map<string, Uploads>();
const previews = new Map<string, string>();
const listeners = new Set<() => void>();

function change(message: string, next: Uploads | null): void {
  if (next === null) held.delete(message);
  else held.set(message, next);
  for (const listener of listeners) listener();
}

function mark(message: string, file: string, state: UploadState): void {
  const now = held.get(message);
  const entry = now?.get(file);
  if (now === undefined || entry === undefined) return;
  change(message, new Map(now).set(file, { ...entry, state }));
}

export function holdFiles(message: string, files: readonly HeldFile[]): void {
  if (files.length === 0) return;
  for (const { file, picked } of files) if (picked.preview !== null) previews.set(file.id, picked.preview);
  change(message, new Map(files.map(({ file, picked }): [string, Held] => [file.id, { body: picked.body, state: 'waiting' }])));
}

export const previewOf = (file: string): string | null => previews.get(file) ?? null;

export const uploadsOf = (message: string): Uploads | null => held.get(message) ?? null;

export const uploadStateOf = (uploads: Uploads | null, file: string): UploadState | null => uploads?.get(file)?.state ?? null;

export function useUploads(message: string): Uploads | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    () => uploadsOf(message),
  );
}

export function settleUploads(message: string, files: readonly ChatFile[], lost: readonly string[]): void {
  if (files.length === 0) return;
  change(message, new Map(files.map((file): [string, Held] => [file.id, { body: null, state: lost.includes(file.id) ? 'unsent' : 'sent' }])));
}

export type PutFile = (file: ChatFile, body: ChatFileBody) => Promise<void>;

const running = new Map<string, Promise<string[]>>();

export const uploadsRunning = (message: string): boolean => running.has(message);

export async function uploadAll(message: string, files: readonly ChatFile[], put: PutFile): Promise<{ lost: string[] }> {
  const before = running.get(message) ?? Promise.resolve([]);
  const next = before.catch(() => []).then(() => uploadEach(message, files, put));
  running.set(message, next);
  try {
    return { lost: await next };
  } finally {
    if (running.get(message) === next) running.delete(message);
  }
}

async function uploadEach(message: string, files: readonly ChatFile[], put: PutFile): Promise<string[]> {
  const lost: string[] = [];
  for (const file of files) {
    const entry = held.get(message)?.get(file.id);
    if (entry?.state === 'sent') continue;
    const body = entry?.body ?? null;
    if (body === null) {
      lost.push(file.id);
      continue;
    }
    mark(message, file.id, 'sending');
    try {
      await put(file, await body());
    } catch (err) {
      mark(message, file.id, 'failed');
      throw err;
    }
    mark(message, file.id, 'sent');
  }
  return lost;
}
