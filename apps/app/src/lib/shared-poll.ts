import { useEffect } from 'react';
import { focusManager, hashKey, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { logError } from './log.js';

const MAX_MS = 5 * 60_000;
const KEY_PART = '\u0000';
const KEY_END = '\u0001';

export interface PollState {
  error: unknown;
  dataUpdatedAt: number;
  errorUpdatedAt: number;
  errorUpdateCount: number;
}

export function pollDelay(state: PollState | undefined, every: number): number {
  if (state === undefined || state.error === null) return every;
  const quiet = state.dataUpdatedAt > 0 ? state.errorUpdatedAt - state.dataUpdatedAt : every * 2 ** Math.min(Math.max(0, state.errorUpdateCount - 1), 8);
  return Math.min(MAX_MS, Math.max(every, quiet));
}

interface Poll {
  users: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const polls = new Map<string, Poll>();

function schedule(client: QueryClient, key: string[], every: number): void {
  const hash = hashKey(key);
  const poll = polls.get(hash);
  if (poll === undefined) return;
  poll.timer = setTimeout(() => {
    poll.timer = null;
    if (polls.get(hash) !== poll) return;
    const run = focusManager.isFocused() ? client.refetchQueries({ queryKey: key, exact: true, type: 'active' }, { cancelRefetch: false }) : Promise.resolve();
    run
      .finally(() => {
        if (polls.get(hash) === poll) schedule(client, key, every);
      })
      .catch(logError('poll'));
  }, pollDelay(client.getQueryState(key), every));
}

function retain(client: QueryClient, key: string[], every: number): void {
  const hash = hashKey(key);
  const poll = polls.get(hash);
  if (poll !== undefined) {
    poll.users += 1;
    return;
  }
  polls.set(hash, { users: 1, timer: null });
  schedule(client, key, every);
}

function release(key: string[]): void {
  const hash = hashKey(key);
  const poll = polls.get(hash);
  if (poll === undefined) return;
  poll.users -= 1;
  if (poll.users > 0) return;
  if (poll.timer !== null) clearTimeout(poll.timer);
  polls.delete(hash);
}

const joinKeys = (keys: string[][]): string => keys.map((key) => `${key.join(KEY_PART)}${KEY_END}`).join('');

const splitKeys = (joined: string): string[][] => joined.split(KEY_END).filter((key) => key !== '').map((key) => key.split(KEY_PART));

export function useSharedPoll(keys: string[][], every: number): void {
  const client = useQueryClient();
  const joined = joinKeys(keys);
  useEffect(() => {
    const list = splitKeys(joined);
    for (const key of list) retain(client, key, every);
    return () => {
      for (const key of list) release(key);
    };
  }, [client, joined, every]);
}
