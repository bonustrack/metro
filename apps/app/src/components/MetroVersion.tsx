import { type ReactNode, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { fetchMode } from '@metro-labs/client/api/mode';
import { releaseAvailability } from '@metro-labs/client/api/metro-release';
import { olderThan } from '@metro-labs/client/api/version';
import { runUpdate } from '@metro-labs/client/api/update';
import { daemonBase } from '@metro-labs/client/auth/daemon';
import { SHRINK } from '../lib/style.js';
import { SettingsSection } from './SettingsSection.js';
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
  throw new Error(`The daemon did not come back on ${version} yet. Check the machine.`);
}

function useMetroUpdate() {
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
    setBusy(true); setStatus('Updating Metro. The agent restarts, this takes a minute…'); setError(null);
    runUpdate().then(async (result) => {
      if (result.restarting) await untilVersion(result.version, base);
      if (daemonBase() !== base) return;
      setStatus(result.updated ? `Installed ${result.version}.${result.restarting ? ' Metro is running this version.' : ' Restart Metro to run this version.'}` : null);
      if (!result.updated) setError('Metro did not install an update. Its release check may be cached for up to 10 minutes. Try again shortly.');
      await Promise.all([client.invalidateQueries({ queryKey: ['mode', base] }), client.invalidateQueries({ queryKey: ['update', base] })]);
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

function UpdateButtons({ u, newer }: { u: ReturnType<typeof useMetroUpdate>; newer: boolean }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return <Row gap={8} wrap>
    <Button size="sm" color="secondary" dark={dark} label="Check for updates" disabled={u.busy || u.release.isFetching || u.mode.isFetching || u.check.isFetching} onPress={u.refresh} />
    {newer ? <Button size="sm" color="primary" dark={dark} label="Update" disabled={u.busy} onPress={u.update} /> : null}
  </Row>;
}

type MetroUpdate = ReturnType<typeof useMetroUpdate>;
const staleQuery = (query: { isError: boolean; dataUpdatedAt: number }, now: number): boolean => query.isError || now - query.dataUpdatedAt > 120_000 || query.dataUpdatedAt > now;

function versionFacts(u: MetroUpdate) {
  const now = Date.now();
  const version = u.mode.data?.version ?? null;
  const modeStale = staleQuery(u.mode, now);
  const availability = releaseAvailability(version, u.release.data, u.release.isError, now);
  const installed = staleQuery(u.check, now) ? null : u.check.data?.current ?? null;
  const restart = olderThan(version, installed ?? '');
  return { version, modeStale, availability, installed, restart };
}

function versionNote(facts: ReturnType<typeof versionFacts>, u: MetroUpdate): string {
  const { version, modeStale, availability, installed, restart } = facts;
  const state = modeStale ? 'Running version unavailable or stale' : availability.label;
  const release = u.release.data;
  const latest = release === undefined ? '' : ` Latest reported release ${release.latest}. Last checked ${new Date(release.checkedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.`;
  return `${version === null ? 'Version unavailable.' : `Running ${version}.`} ${state}.${latest}${restart ? ` Installed ${installed}; restart Metro to run it.` : ''}`;
}

function updateOffered(facts: ReturnType<typeof versionFacts>, u: MetroUpdate): boolean {
  return !facts.modeStale && facts.availability.kind === 'newer' && (facts.installed === null || olderThan(facts.installed, u.release.data?.latest ?? ''));
}

function updateQuiet(facts: ReturnType<typeof versionFacts>, u: MetroUpdate): boolean {
  return u.status === null && u.error === null && !facts.restart && facts.availability.kind === 'current' && !facts.modeStale;
}

function UpdateDetails({ u }: { u: MetroUpdate }): ReactNode {
  return <Col gap={6} style={SHRINK}>
    {u.status === null ? null : <Text size="2xs">{u.status}</Text>}
    {u.error === null ? null : <Text size="2xs" role="danger">{u.error}</Text>}
    {u.check.isError ? <Text size="2xs" role="secondary">Could not check the installed package version.</Text> : null}
  </Col>;
}

export function MetroVersion({ quiet = false }: { quiet?: boolean }): ReactNode {
  const u = useMetroUpdate();
  const facts = versionFacts(u);
  const note = versionNote(facts, u);
  const details = <UpdateDetails u={u} />;
  const buttons = <UpdateButtons u={u} newer={updateOffered(facts, u)} />;
  if (quiet) {
    if (updateQuiet(facts, u)) return null;
    return <Col gap={12} padding={16} radius={8} surface="raised">
      <Text size="2xs">{note}</Text>{details}{buttons}
    </Col>;
  }
  return <SettingsSection title="Version" note={note}>{buttons}{details}</SettingsSection>;
}
