import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fetchMode } from '@metro-labs/client/api/mode';
import { releaseAvailability } from '@metro-labs/client/api/metro-release';
import { olderThan } from '@metro-labs/client/api/version';
import { runUpdate } from '@metro-labs/client/api/update';
import { daemonBase } from '@metro-labs/client/auth/daemon';
import { queryError, useModeQuery, useUpdateQuery } from '../lib/queries.js';
import { useMetroRelease } from '../lib/metro-release.js';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function untilVersion(version: string, base: string): Promise<void> {
  const until = Date.now() + 4 * 60_000;
  while (Date.now() < until) {
    await wait(3_000);
    if (daemonBase() !== base) throw new Error('Agent changed. Check the updated agent’s version.');
    const mode = await fetchMode().catch(() => null);
    if (mode?.version === version) return;
  }
  throw new Error(`Metro is not back on ${version} yet. Check the machine.`);
}

export function useMetroUpdate() {
  const client = useQueryClient();
  const mode = useModeQuery({ live: true });
  const check = useUpdateQuery();
  const release = useMetroRelease();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => { tick((value) => value + 1); }, 15_000);
    return () => { clearInterval(timer); };
  }, []);
  const update = (): void => {
    const base = daemonBase();
    setBusy(true); setStatus('Updating Metro. The agent restarts in about a minute…'); setError(null);
    runUpdate().then(async (result) => {
      if (result.restarting) await untilVersion(result.version, base);
      if (daemonBase() !== base) return;
      setStatus(result.updated ? `Installed ${result.version}.${result.restarting ? ' Metro is running this version.' : ' Restart Metro to run this version.'}` : null);
      if (!result.updated) setError('No update was installed. The release check can lag up to 10 minutes, so try again soon.');
      await client.invalidateQueries({ predicate: (query) => query.queryKey[1] === base });
    }).catch((err: unknown) => {
      if (daemonBase() !== base) return;
      setStatus(null); setError(queryError(err, 'Could not update Metro.'));
    }).finally(() => { setBusy(false); });
  };
  const refresh = (): void => {
    Promise.all([release.refetch({ cancelRefetch: false }), mode.refetch({ cancelRefetch: false }), check.refetch({ cancelRefetch: false })])
      .catch((err: unknown) => { setError(queryError(err, 'Could not check for updates.')); });
  };
  return { mode, check, release, busy, status, error, update, refresh };
}

export type MetroUpdate = ReturnType<typeof useMetroUpdate>;
const staleQuery = (query: { isError: boolean; dataUpdatedAt: number }, now: number): boolean => query.isError || now - query.dataUpdatedAt > 120_000 || query.dataUpdatedAt > now;

export function versionFacts(u: MetroUpdate) {
  const now = Date.now();
  const version = u.mode.data?.version ?? null;
  const modeStale = staleQuery(u.mode, now);
  const availability = releaseAvailability(version, u.release.data, u.release.isError, now);
  const installed = staleQuery(u.check, now) ? null : u.check.data?.current ?? null;
  const restart = olderThan(version, installed ?? '');
  return { version, modeStale, availability, installed, restart };
}

export function updateOffered(facts: ReturnType<typeof versionFacts>, u: MetroUpdate): boolean {
  return !facts.modeStale && facts.availability.kind === 'newer' && (facts.installed === null || olderThan(facts.installed, u.release.data?.latest ?? ''));
}
