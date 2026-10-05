import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { isRecord } from '@metro-labs/core/is-record';
import type { Unanswered } from './inbox.js';

export const INTERRUPTED_NOTICE = 'The SDK stopped before finishing a chat request. Check Conversations before retrying; actions may already have run.';

function scanTranscript(fd: number, wanted: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  const chunk = Buffer.alloc(64 * 1024);
  let overlap = '';
  for (let size = readSync(fd, chunk); size > 0; size = readSync(fd, chunk)) {
    const text = overlap + chunk.toString('latin1', 0, size);
    for (const uuid of wanted) if (text.includes(`"${uuid}"`)) found.add(uuid);
    if (found.size === wanted.size) break;
    overlap = text.slice(-37);
  }
  return found;
}

function transcriptUuids(path: string | null, inputs: readonly Unanswered[]): Set<string> {
  const wanted = new Set(inputs.flatMap((input) => input.state !== 'started' && input.uuid !== undefined ? [input.uuid] : []));
  if (path === null || wanted.size === 0) return new Set();
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    return scanTranscript(fd, wanted);
  } catch (err) {
    if (isRecord(err) && err.code === 'ENOENT') return new Set();
    throw new Error('The saved Agent SDK transcript cannot be checked. Restore it before starting.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function recoverInputs(inputs: readonly Unanswered[], transcript: string | null): { unanswered: Unanswered[]; interrupted: Unanswered[] } {
  const seen = transcriptUuids(transcript, inputs);
  const unanswered: Unanswered[] = [];
  const interrupted: Unanswered[] = [];
  for (const input of inputs) {
    const entry = { ...input, uuid: input.uuid ?? randomUUID(), state: input.state ?? 'queued' };
    if (entry.state === 'started' || seen.has(entry.uuid)) interrupted.push({ ...entry, state: 'started' });
    else unanswered.push(entry);
  }
  return { unanswered, interrupted };
}
