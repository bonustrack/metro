import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createEnrollment } from '@metro-labs/client/api/enrollment';
import { fetchModel, type ModelSync } from '@metro-labs/client/api/model';
import { accountScopeIdentity, activeAccount } from '@metro-labs/client/auth/account';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { logError } from './log.js';
import { syncSelectedBox, useModelQuery } from './model-queries.js';
import { boxKey, queryError } from './queries.js';

export type Attempt = { state: 'running' } | { state: 'done' } | { state: 'failed'; error: string };

interface Box {
  id: string;
  host: string;
}

export interface EnrollCheck {
  admin: boolean;
  sync: ModelSync | null | undefined;
  readFailed: boolean;
  attempt: Attempt | undefined;
}

export interface LinkWords {
  line: string;
  short: string;
  error: string | null;
  danger: boolean;
}

const RUNNING: Attempt = { state: 'running' };
const DONE: Attempt = { state: 'done' };
const FALLBACK = 'Metro could not finish linking it. Try again.';
const LINKING: LinkWords = { line: 'Linking this agent to the organization…', short: 'Linking to the organization…', error: null, danger: false };
const UNLINKED: LinkWords = {
  line: 'This agent is not linked to the organization yet, so it has no model. It links by itself when an admin of the organization opens its page.',
  short: 'Not linked to the organization yet, so no model',
  error: null,
  danger: true,
};

const attempts = new Map<string, Attempt>();
const listeners = new Set<() => void>();

const slotOf = (box: Box | null): string => (box === null ? '' : `${box.id}\n${box.host}`);
const isAdmin = (): boolean => activeAccount()?.role === 'admin';

function put(slot: string, attempt: Attempt | null): void {
  if (attempt === null) attempts.delete(slot);
  else attempts.set(slot, attempt);
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const shouldEnroll = ({ admin, sync, readFailed, attempt }: EnrollCheck): boolean => admin && !readFailed && sync?.enrolled === false && attempt === undefined;

export function linkWords(sync: ModelSync | null | undefined, attempt: Attempt | undefined, admin: boolean): LinkWords | null {
  if (sync?.enrolled !== false) return null;
  if (attempt?.state === 'failed') return { line: `This agent could not link to the organization: ${attempt.error}`, short: 'Could not link to the organization', error: attempt.error, danger: true };
  return admin ? LINKING : UNLINKED;
}

async function stillUnlinked(client: QueryClient): Promise<boolean> {
  try {
    const model = await client.fetchQuery({ queryKey: boxKey('model'), queryFn: fetchModel, staleTime: 0 });
    return model.sync?.enrolled === false;
  } catch (err) {
    logError('model read before linking')(err);
    return false;
  }
}

async function link(box: Box, client: QueryClient): Promise<boolean> {
  if (!(await stillUnlinked(client))) return false;
  const enrollment = createEnrollment(box);
  try {
    await enrollment.run();
  } finally {
    enrollment.dispose();
  }
  await syncSelectedBox(client);
  return true;
}

function failure(box: Box, scope: number, err: unknown): Attempt | null {
  const here = currentServer();
  const moved = scope !== accountScopeIdentity() || here?.id !== box.id || here.host !== box.host;
  return moved ? null : { state: 'failed', error: queryError(err, FALLBACK) };
}

function enrollBox(box: Box, client: QueryClient): void {
  const slot = slotOf(box);
  if (attempts.get(slot) === RUNNING) return;
  const scope = accountScopeIdentity();
  put(slot, RUNNING);
  link(box, client)
    .then(
      (linked) => (linked ? DONE : null),
      (err: unknown) => failure(box, scope, err),
    )
    .then((next) => {
      put(slot, next);
    })
    .catch(logError('organization link'));
}

const useAttempt = (box: Box | null): Attempt | undefined => {
  const slot = slotOf(box);
  return useSyncExternalStore(subscribe, () => attempts.get(slot), () => attempts.get(slot));
};

export function useAutoEnroll(box: Box): void {
  const client = useQueryClient();
  const model = useModelQuery(false);
  const attempt = useAttempt(box);
  const start = shouldEnroll({ admin: isAdmin(), sync: model.data?.sync, readFailed: model.error !== null, attempt });
  const { id, host } = box;
  useEffect(() => {
    if (start) enrollBox({ id, host }, client);
  }, [start, id, host, client]);
}

export const useLinkWords = (sync: ModelSync | null | undefined): LinkWords | null => linkWords(sync, useAttempt(currentServer()), isAdmin());

export function useRetryLink(): () => void {
  const client = useQueryClient();
  return () => {
    const box = currentServer();
    if (box !== null) enrollBox(box, client);
  };
}
