import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@stage-labs/kit/react-native/button';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { fetchBootView, type BootView } from '@metro-labs/client/api/launch';
import { whenLabel } from '@metro-labs/client/api/when';
import { type Server } from '@metro-labs/client/api/servers';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { AgentDeepPage } from './agent/AgentDeepPage.js';
import { ErrorState } from './ui/ErrorState.js';
import { Wide } from './ui/Layout.js';
import { LogBlock } from './ui/LogBlock.js';
import { RowsSkeleton } from './ui/RowsSkeleton.js';
import { StateBlock } from './ui/StateBlock.js';
import { useServersQuery } from '../lib/queries.js';
import { useDocumentTitle } from '../lib/title.js';

const NOT_ISSUED = 'Metro did not issue this server, so there is no instance to read.';

function summary(view: BootView | null): string {
  if (view === null) return 'Reading the instance console from AWS…';
  const when = view.at === null ? '' : ` Read ${whenLabel(view.at)}. AWS refreshes it every few minutes.`;
  if (view.lines.length === 0) return `The setup script has not printed anything yet.${when}`;
  if (view.finished) return `The setup script finished.${when}`;
  return `The setup script is still running, or stopped at the last line.${when}`;
}

function useBootLog(server: Server | undefined): { view: BootView | null; error: string | null; busy: boolean; refresh: () => void } {
  const [view, setView] = useState<BootView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const id = server?.id ?? null;
  const launched = server?.instanceId ?? null;
  useEffect(() => {
    if (id === null || launched === null) return undefined;
    let live = true;
    setBusy(true);
    setError(null);
    fetchBootView(id)
      .then((next) => {
        if (live) setView(next);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : 'Could not read the launch log.');
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [id, launched, tick]);
  return { view, error, busy, refresh: () => { setTick((n) => n + 1); } };
}

function Body({ server, log }: { server: Server | undefined; log: ReturnType<typeof useBootLog> }): ReactNode {
  if (server === undefined) return <RowsSkeleton rows={4} leading={false} />;
  if (server.instanceId === null) return <StateBlock icon="server" title="No launch log" text={NOT_ISSUED} />;
  if (log.error !== null) return <ErrorState title="Could not read the launch log" text={log.error} onRetry={log.refresh} />;
  if (log.view === null) return <RowsSkeleton rows={6} leading={false} trailing={false} />;
  return (
    <Wide>
      <LogBlock lines={log.view.lines.length === 0 ? ['Nothing printed yet.'] : log.view.lines} maxHeight={null} />
    </Wide>
  );
}

export function LaunchLogPage({ project }: { project: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const servers = useServersQuery();
  const here = currentServer();
  const server = servers.data?.find((s) => s.id === here?.id);
  const log = useBootLog(server);
  useDocumentTitle('Launch log');
  const refresh = server?.instanceId === null || server === undefined ? undefined : <Button size="md" color="secondary" dark={dark} label="Refresh" loading={log.busy} disabled={log.busy} onPress={log.refresh} />;
  const subtitle = server?.instanceId === null ? undefined : summary(log.view);
  return (
    <AgentDeepPage project={project} tab="settings" trail={[{ label: 'Launch log' }]} title="Launch log" subtitle={subtitle} action={refresh}>
      <Body server={server} log={log} />
    </AgentDeepPage>
  );
}
