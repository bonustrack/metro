import { type ReactNode, useEffect } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { AuthError, StoppedError } from '@metro-labs/client/api/client';
import { type Server } from '@metro-labs/client/api/servers';
import { baseFromSegment, currentServer, daemonBase, daemonHost, storeDaemon, storeServerId } from '@metro-labs/client/auth/daemon';
import { selectionProject, type Selection } from '@metro-labs/client/selection';
import { AgentPanel } from '../AgentPanel.js';
import { Notice } from '../Notice.js';
import { OfflinePanel, worksOffline } from '../Offline.js';
import { StoppedNotice } from '../StoppedNotice.js';
import { TerminalPage } from '../Terminal.js';
import { Tabbed } from '../tabbed.js';
import { AgentHeader } from './AgentHeader.js';
import { AgentSubPages, AgentTabs } from './AgentTabs.js';
import { isPageRoot } from '../../lib/agent-tabs.js';
import { useIsNarrow } from '../../lib/media.js';
import { useSessionQuery } from '../../lib/queries.js';
import { noteTitle } from '../../lib/title.js';
import { webOnly } from '../../lib/style.js';

const STICKY = webOnly({ position: 'sticky', top: 0, zIndex: 3 });

interface AgentScreenProps {
  server: Server;
  selection: Selection;
  onLock: () => void;
}

function useRememberAgent(selection: Selection): void {
  const routed = selectionProject(selection);
  useEffect(() => {
    const server = currentServer();
    if (routed === null || server === null) return;
    storeServerId(server.id);
    storeDaemon(baseFromSegment(server.host));
  }, [routed]);
}

function AgentDetail({ server, selection, children }: { server: Server; selection: Selection; children: ReactNode }): ReactNode {
  const palette = useKitPalette();
  const narrow = useIsNarrow();
  const project = selectionProject(selection) ?? server.id;
  const top = narrow ? null : { backgroundColor: palette.bg };
  return (
    <Col gap={24}>
      <Col gap={20} style={narrow ? undefined : [STICKY, top]}>
        <AgentHeader server={server} project={project} />
        <AgentTabs selection={selection} project={project} />
      </Col>
      <AgentSubPages selection={selection} project={project} />
      <Tabbed.Provider value={isPageRoot(selection)}>{children}</Tabbed.Provider>
    </Col>
  );
}

function useBoxState(): { error: Error | null; retry: () => void } {
  const { data: subject, error, refetch } = useSessionQuery();
  useEffect(() => {
    if (subject === undefined) noteTitle(null);
  }, [subject]);
  const retry = (): void => {
    refetch().catch(() => undefined);
  };
  return { error, retry };
}

function blocked(error: Error | null, retry: () => void, onLock: () => void): ReactNode {
  if (error instanceof AuthError && error.refused)
    return <Notice text={`${daemonHost(daemonBase())} refused this account: ${error.message}`} onRetry={onLock} retryLabel="Log in with another account" />;
  if (error instanceof StoppedError) return <StoppedNotice onStarted={retry} />;
  return null;
}

export function AgentScreen({ server, selection, onLock }: AgentScreenProps): ReactNode {
  const { error, retry } = useBoxState();
  useRememberAgent(selection);
  const notice = blocked(error, retry, onLock);
  const offline = error !== null && notice === null;
  if (selection.kind === 'terminal') return notice ?? (offline ? <OfflinePanel onRetry={retry} /> : <TerminalPage />);
  const page = offline && !worksOffline(selection.kind) ? <OfflinePanel onRetry={retry} /> : <AgentPanel selection={selection} />;
  return (
    <AgentDetail server={server} selection={selection}>
      {notice ?? page}
    </AgentDetail>
  );
}
