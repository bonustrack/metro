import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { Spinner } from './Spinner.js';
import { Loading } from './Loading.js';
import { Dropdown } from './Dropdown.js';
import { ConfirmModal } from './ConfirmModal.js';
import { FactRow, SettingsGroup, SettingsSection } from './SettingsSection.js';
import { orgKey, queryError, useStorageQuery } from '../api/queries.js';
import { applying, diskText, growDisk, growRunning, growText, monthlyDisk, type GrowJob, type StorageView } from '../api/storage.js';
import { activeAccount } from '../auth/account.js';

type Growable = Extract<StorageView, { growable: true }>;

const TITLE = 'Storage';
const GROW_TITLE = 'Grow disk';
const GROW_NOTE = 'A disk can only grow. The server restarts once, about 1 minute offline.';
const NO_BIGGER = 'Metro offers no bigger size for this disk.';
const MEMBER_NOTE = 'Only an admin of the organization can grow the disk.';
const WAIT_NOTE = 'AWS is moving the server between states. Wait until it runs.';

interface Grow {
  busy: boolean;
  error: string | null;
  run: (sizeGib: number, then: () => void) => void;
  clear: () => void;
}

function useGrow(serverId: string): Grow {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (sizeGib: number, then: () => void): void => {
    setBusy(true);
    setError(null);
    growDisk(serverId, sizeGib)
      .then(async (view) => {
        client.setQueryData(orgKey('storage', serverId), view);
        then();
        await client.invalidateQueries({ queryKey: orgKey('storage', serverId) });
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not grow the disk.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const clear = (): void => {
    setError(null);
  };
  return { busy, error, run, clear };
}

function confirmLines(view: Growable, sizeGib: number): string[] {
  const price = view.gbMonthUsd === null ? [] : [`AWS bills about ${monthlyDisk(sizeGib, view.gbMonthUsd)} for it, ${monthlyDisk(view.sizeGib, view.gbMonthUsd)} now.`];
  const restart =
    view.state === 'running'
      ? 'Then the server restarts once to use the new space. Your agent is offline for about a minute and its Claude session restarts.'
      : 'The server is stopped, so it uses the new space when it starts.';
  return [
    `AWS grows the disk from ${String(view.sizeGib)} to ${String(sizeGib)} GB. This cannot be undone: a disk never shrinks back.`,
    restart,
    ...price,
    'AWS takes the next change only once this one is fully done, which can take a few hours.',
  ];
}

function Notice({ text, danger = false }: { text: string; danger?: boolean }): ReactNode {
  return (
    <SettingsGroup title={TITLE}>
      <div className="settings-pad">
        <Text size="md" role={danger ? 'danger' : 'secondary'}>
          {text}
        </Text>
      </div>
    </SettingsGroup>
  );
}

function JobRow({ job }: { job: GrowJob }): ReactNode {
  const palette = useKitPalette();
  const running = growRunning(job);
  return (
    <SettingsSection title={running ? 'Growing' : 'Last change'} leading={running ? <Spinner size={16} color={palette.link} /> : undefined}>
      <Text size="md" role={job.phase === 'failed' ? 'danger' : 'secondary'}>
        {growText(job)}
      </Text>
    </SettingsSection>
  );
}

function Controls({ view, onPick }: { view: Growable; onPick: (sizeGib: number) => void }): ReactNode {
  if (growRunning(view.job)) return null;
  if (activeAccount()?.role !== 'admin') return <SettingsSection title={GROW_TITLE} note={MEMBER_NOTE}>{null}</SettingsSection>;
  if (applying(view.modification)) {
    const progress = view.modification?.progress ?? 0;
    return <SettingsSection title={GROW_TITLE} note={`AWS is still applying the last change (${String(progress)}%). The disk can grow again once it is done.`}>{null}</SettingsSection>;
  }
  if (view.state !== 'running' && view.state !== 'stopped') return <SettingsSection title={GROW_TITLE} note={WAIT_NOTE}>{null}</SettingsSection>;
  if (view.options.length === 0) return <SettingsSection title={GROW_TITLE} note={NO_BIGGER}>{null}</SettingsSection>;
  return (
    <SettingsSection title={GROW_TITLE} note={GROW_NOTE}>
      <Dropdown
        className="size-picker"
        label="Disk sizes"
        button={{ label: 'Choose a size', color: 'secondary', size: 'sm' }}
        items={view.options.map((sizeGib) => ({
          label: diskText(sizeGib, '', view.gbMonthUsd),
          onSelect: () => {
            onPick(sizeGib);
          },
        }))}
      />
    </SettingsSection>
  );
}

function GrowableStorage({ serverId, view }: { serverId: string; view: Growable }): ReactNode {
  const grow = useGrow(serverId);
  const [picked, setPicked] = useState<number | null>(null);
  const close = (): void => {
    if (grow.busy) return;
    setPicked(null);
    grow.clear();
  };
  return (
    <SettingsGroup title={TITLE}>
      <FactRow label="Disk" value={diskText(view.sizeGib, view.type, view.gbMonthUsd)} />
      {view.job === null ? null : <JobRow job={view.job} />}
      <Controls view={view} onPick={setPicked} />
      {picked === null ? null : (
        <ConfirmModal
          open
          title={`Grow the disk to ${String(picked)} GB`}
          lines={confirmLines(view, picked)}
          confirmWord="grow"
          confirmLabel="Grow"
          busy={grow.busy}
          error={grow.error}
          onClose={close}
          onConfirm={() => {
            grow.run(picked, () => {
              setPicked(null);
            });
          }}
        />
      )}
    </SettingsGroup>
  );
}

export function ServerStorageSection({ serverId, launchedOnly = false }: { serverId: string; launchedOnly?: boolean }): ReactNode {
  const storage = useStorageQuery(serverId);
  if (storage.data === null) return null;
  if (launchedOnly && storage.data?.growable !== true) return null;
  if (storage.data === undefined) {
    if (storage.error === null) return <Loading />;
    return <Notice text={queryError(storage.error, 'Could not read the disk of this server.')} danger />;
  }
  if (!storage.data.growable) return <Notice text={storage.data.reason} />;
  return <GrowableStorage serverId={serverId} view={storage.data} />;
}
