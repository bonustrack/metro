import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Spinner } from './Spinner.js';
import { ErrorState } from './ui/ErrorState.js';
import { RowsSkeleton } from './ui/RowsSkeleton.js';
import { Dropdown } from './Dropdown.js';
import { ConfirmModal } from './ConfirmModal.js';
import { Group } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { Control, Fact, NoteRow } from './settings/rows.js';
import { orgKey, queryError, useSizeQuery } from '../lib/queries.js';
import { jobRunning, monthlyLabel, phaseText, resizeServer, sizeText, stateText, type ResizeJob, type ServerSize, type SizeView } from '@metro-labs/client/api/size';
import { activeAccount } from '@metro-labs/client/auth/account';
import { regionLabel } from '@metro-labs/client/aws/regions';

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
    `The server stops, becomes ${sizeText(picked)} and starts again, 1 to 2 minutes offline.`,
    'Your agent does not answer meanwhile. Its session restarts when the server is back.',
    ...price,
  ];
}

function Notice({ text }: { text: string }): ReactNode {
  return (
    <Group label={TITLE}>
      <NoteRow text={text} />
    </Group>
  );
}

function JobRow({ job }: { job: ResizeJob }): ReactNode {
  const palette = useKitPalette();
  const running = jobRunning(job);
  return (
    <Item
      title={running ? 'Resizing' : 'Last resize'}
      subtitle={phaseText(job)}
      subtitleTone={job.phase === 'failed' ? 'danger' : 'secondary'}
      trailing={running ? <Spinner color={palette.link} /> : undefined}
    />
  );
}

function StartRow({ view, resize }: { view: Resizable; resize: Resize }): ReactNode {
  return (
    <Control title="Start" note={STOPPED_NOTE} error={resize.error}>
      <Button
        size="md"
        color="primary"
        label={resize.busy ? 'Starting…' : 'Start'}
        disabled={resize.busy}
        onPress={() => {
          resize.run(view.type, () => undefined);
        }}
      />
    </Control>
  );
}

function ChangeRow({ view, onPick }: { view: Resizable; onPick: (size: ServerSize) => void }): ReactNode {
  if (view.options.length === 0) return <Control title={CHANGE} note={NO_OTHER} />;
  return (
    <Control title={CHANGE} note={CHANGE_NOTE}>
      <Dropdown
        label="Sizes"
        button={{ label: 'Choose a size', color: 'secondary', size: 'sm' }}
        items={view.options.map((size) => ({
          label: sizeText(size),
          onSelect: () => {
            onPick(size);
          },
        }))}
      />
    </Control>
  );
}

function Controls({ view, resize, onPick }: { view: Resizable; resize: Resize; onPick: (size: ServerSize) => void }): ReactNode {
  if (jobRunning(view.job)) return null;
  if (activeAccount()?.role !== 'admin') return <Control title={CHANGE} note={MEMBER_NOTE} />;
  if (view.state === 'stopped') return <StartRow view={view} resize={resize} />;
  if (view.state !== 'running') return <Control title={CHANGE} note={WAIT_NOTE} />;
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
    <Group label={TITLE}>
      <Fact label="Current" value={sizeText(view.current)} />
      <Fact label="In AWS" value={stateText(view.state)} />
      {view.region === '' ? null : <Fact label="Region" value={regionLabel(view.region)} />}
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
    </Group>
  );
}

export function ServerSizeSection({ serverId, launchedOnly = false }: { serverId: string; launchedOnly?: boolean }): ReactNode {
  const size = useSizeQuery(serverId);
  if (size.data === null) return null;
  if (launchedOnly && size.data?.resizable !== true) return null;
  if (size.data === undefined) {
    return (
      <Group label={TITLE}>
        {size.error === null ? <RowsSkeleton rows={2} leading={false} /> : <ErrorState title="Could not read the size of this server" text={queryError(size.error, 'Metro did not answer.')} onRetry={size.refetch} />}
      </Group>
    );
  }
  if (!size.data.resizable) return <Notice text={size.data.reason} />;
  return <ResizableSize serverId={serverId} view={size.data} />;
}
