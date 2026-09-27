import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { Spinner } from './Spinner.js';
import { Loading } from './Loading.js';
import { Dropdown } from './Dropdown.js';
import { ConfirmModal } from './ConfirmModal.js';
import { FactRow, SettingsGroup, SettingsSection } from './SettingsSection.js';
import { orgKey, queryError, useSizeQuery } from '../api/queries.js';
import { jobRunning, monthlyLabel, phaseText, resizeServer, sizeText, stateText, type ResizeJob, type ServerSize, type SizeView } from '../api/size.js';
import { activeAccount } from '../auth/account.js';

type Resizable = Extract<SizeView, { resizable: true }>;

const TITLE = 'Size';
const CHANGE = 'Change size';
const CHANGE_NOTE = 'Stops the server, changes its size and starts it again. 1 to 2 minutes offline.';
const NO_OTHER = 'AWS offers no other size of this kind in this region.';
const MEMBER_NOTE = 'Only an admin of the organization can change the size.';
const STOPPED_NOTE = 'The server is stopped in AWS, so your agent does not answer.';
const WAIT_NOTE = 'AWS is moving the server between states. Wait until it runs.';

interface Resize {
  busy: boolean;
  error: string | null;
  run: (type: string, then: () => void) => void;
  clear: () => void;
}

function useResize(serverId: string): Resize {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (type: string, then: () => void): void => {
    setBusy(true);
    setError(null);
    resizeServer(serverId, type)
      .then(async (view) => {
        client.setQueryData(orgKey('size', serverId), view);
        then();
        await client.invalidateQueries({ queryKey: orgKey('size', serverId) });
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not change the size.'));
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

function confirmLines(view: Resizable, picked: ServerSize): string[] {
  const price =
    picked.hourlyUsd !== null && view.current.hourlyUsd !== null
      ? [`AWS bills about ${monthlyLabel(picked.hourlyUsd)} for it, ${monthlyLabel(view.current.hourlyUsd)} now.`]
      : [];
  return [
    `The server stops, becomes ${sizeText(picked)}, and starts again. It is offline for 1 to 2 minutes.`,
    'Your agent does not answer meanwhile, and its Claude session restarts once the server is back.',
    ...price,
  ];
}

function Notice({ text, danger = false }: { text: string; danger?: boolean }): ReactNode {
  return (
    <SettingsGroup title={TITLE}>
      <div className="settings-pad">
        <Text size="sm" role={danger ? 'danger' : 'secondary'}>
          {text}
        </Text>
      </div>
    </SettingsGroup>
  );
}

function JobRow({ job }: { job: ResizeJob }): ReactNode {
  const palette = useKitPalette();
  const running = jobRunning(job);
  return (
    <SettingsSection title={running ? 'Resizing' : 'Last resize'} leading={running ? <Spinner size={16} color={palette.link} /> : undefined}>
      <Text size="sm" role={job.phase === 'failed' ? 'danger' : 'secondary'}>
        {phaseText(job)}
      </Text>
    </SettingsSection>
  );
}

function StartRow({ view, resize }: { view: Resizable; resize: Resize }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <SettingsSection title="Start" note={STOPPED_NOTE}>
      <Button
        size="sm"
        color="primary"
        dark={dark}
        label={resize.busy ? 'Starting…' : 'Start'}
        disabled={resize.busy}
        onPress={() => {
          resize.run(view.type, () => undefined);
        }}
      />
      {resize.error === null ? null : (
        <Text size="sm" role="danger">
          {resize.error}
        </Text>
      )}
    </SettingsSection>
  );
}

function ChangeRow({ view, onPick }: { view: Resizable; onPick: (size: ServerSize) => void }): ReactNode {
  if (view.options.length === 0) return <SettingsSection title={CHANGE} note={NO_OTHER}>{null}</SettingsSection>;
  return (
    <SettingsSection title={CHANGE} note={CHANGE_NOTE}>
      <Dropdown
        className="size-picker"
        label="Sizes"
        button={{ label: 'Choose a size', color: 'secondary', size: 'sm' }}
        items={view.options.map((size) => ({
          label: sizeText(size),
          onSelect: () => {
            onPick(size);
          },
        }))}
      />
    </SettingsSection>
  );
}

function Controls({ view, resize, onPick }: { view: Resizable; resize: Resize; onPick: (size: ServerSize) => void }): ReactNode {
  if (jobRunning(view.job)) return null;
  if (activeAccount()?.role !== 'admin') return <SettingsSection title={CHANGE} note={MEMBER_NOTE}>{null}</SettingsSection>;
  if (view.state === 'stopped') return <StartRow view={view} resize={resize} />;
  if (view.state !== 'running') return <SettingsSection title={CHANGE} note={WAIT_NOTE}>{null}</SettingsSection>;
  return <ChangeRow view={view} onPick={onPick} />;
}

function ResizableSize({ serverId, view }: { serverId: string; view: Resizable }): ReactNode {
  const resize = useResize(serverId);
  const [picked, setPicked] = useState<ServerSize | null>(null);
  const close = (): void => {
    if (resize.busy) return;
    setPicked(null);
    resize.clear();
  };
  return (
    <SettingsGroup title={TITLE}>
      <FactRow label="Current" value={sizeText(view.current)} />
      <FactRow label="In AWS" value={stateText(view.state)} />
      {view.job === null ? null : <JobRow job={view.job} />}
      <Controls view={view} resize={resize} onPick={setPicked} />
      {picked === null ? null : (
        <ConfirmModal
          open
          title={`Resize to ${picked.type}`}
          lines={confirmLines(view, picked)}
          confirmWord="resize"
          confirmLabel="Resize"
          busy={resize.busy}
          error={resize.error}
          onClose={close}
          onConfirm={() => {
            resize.run(picked.type, () => {
              setPicked(null);
            });
          }}
        />
      )}
    </SettingsGroup>
  );
}

export function ServerSizeSection({ serverId, launchedOnly = false }: { serverId: string; launchedOnly?: boolean }): ReactNode {
  const size = useSizeQuery(serverId);
  if (size.data === null) return null;
  if (launchedOnly && size.data?.resizable !== true) return null;
  if (size.data === undefined) {
    if (size.error === null) return <Loading />;
    return <Notice text={queryError(size.error, 'Could not read the size of this server.')} danger />;
  }
  if (!size.data.resizable) return <Notice text={size.data.reason} />;
  return <ResizableSize serverId={serverId} view={size.data} />;
}
