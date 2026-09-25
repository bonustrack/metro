import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { SettingsSection } from './SettingsSection.js';
import { queryError, useModeQuery, useUpdateQuery } from '../api/queries.js';
import { fetchMode } from '../api/mode.js';
import { runUpdate } from '../api/update.js';

const POLL_MS = 3_000;
const POLL_MAX_MS = 4 * 60_000;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function untilVersion(version: string): Promise<void> {
  const until = Date.now() + POLL_MAX_MS;
  while (Date.now() < until) {
    await wait(POLL_MS);
    const mode = await fetchMode().catch(() => null);
    if (mode?.version === version) return;
  }
  throw new Error(`The daemon did not come back on ${version} yet. Check the machine.`);
}

type Phase = { kind: 'idle' } | { kind: 'updating'; to: string } | { kind: 'done'; to: string };

interface MetroUpdate {
  version: string | null;
  newer: boolean;
  checked: boolean;
  idle: boolean;
  status: string | null;
  error: string | null;
  update: () => void;
}

function statusOf(phase: Phase): string | null {
  if (phase.kind === 'updating') return `Updating to ${phase.to}. The agent restarts, this takes a minute…`;
  if (phase.kind === 'done') return `Updated to ${phase.to}.`;
  return null;
}

function useMetroUpdate(): MetroUpdate {
  const client = useQueryClient();
  const mode = useModeQuery();
  const check = useUpdateQuery();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const update = (): void => {
    setPhase({ kind: 'updating', to: check.data?.latest ?? '' });
    setError(null);
    runUpdate()
      .then(async (result) => {
        if (result.restarting) await untilVersion(result.version);
        setPhase({ kind: 'done', to: result.version });
        await client.invalidateQueries();
      })
      .catch((err: unknown) => {
        setPhase({ kind: 'idle' });
        setError(queryError(err, 'Could not update metro.'));
      });
  };
  return {
    version: mode.data?.version ?? null,
    newer: check.data?.newer === true,
    checked: check.data !== undefined,
    idle: phase.kind === 'idle',
    status: statusOf(phase),
    error,
    update,
  };
}

function versionNote(u: MetroUpdate, version: string): string {
  if (u.status !== null) return u.status;
  if (u.newer) return `Version ${version}. A new version is ready.`;
  return u.checked ? `Version ${version}. Up to date.` : `Version ${version}.`;
}

function UpdateNotice({ u, button }: { u: MetroUpdate; button: ReactNode }): ReactNode {
  if (u.status === null && u.error === null && !u.newer) return null;
  return (
    <div className="update-notice">
      <Text size="sm">{u.status ?? u.error ?? 'A new version of Metro is ready.'}</Text>
      {button}
    </div>
  );
}

export function MetroVersion({ quiet = false }: { quiet?: boolean }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const u = useMetroUpdate();
  if (u.version === null) return null;
  const button = u.newer && u.idle ? <Button size="sm" color="primary" dark={dark} label="Update" onPress={u.update} /> : null;
  if (quiet) return <UpdateNotice u={u} button={button} />;
  return (
    <SettingsSection title="Version" note={versionNote(u, u.version)}>
      {button}
      {u.error === null ? null : <Text size="sm" role="danger">{u.error}</Text>}
    </SettingsSection>
  );
}
