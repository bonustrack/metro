import { type ReactNode, useEffect } from 'react';
import { currentServer, storeDaemon, baseFromSegment, storedServerId, storeServerId } from '@metro-labs/client/auth/daemon';
import { selectionProject, type Selection } from '@metro-labs/client/selection';
import { AgentPanel } from './AgentPanel.js';
import { AgentSidebar } from './AgentSidebar.js';
import { Frame } from './Shell.js';
import { TerminalPage } from './Terminal.js';
import { OfflinePanel, worksOffline } from './Offline.js';

interface Offline {
  retry: () => void;
}

interface DashboardProps {
  selection: Selection;
  onLock: () => void;
  offline: Offline | null;
}

export function Dashboard({ selection, onLock, offline }: DashboardProps): ReactNode {
  const routed = selectionProject(selection);
  const project = routed ?? storedServerId();
  useEffect(() => {
    const server = currentServer();
    if (routed === null || server === null) return;
    storeServerId(server.id);
    storeDaemon(baseFromSegment(server.host));
  }, [routed]);
  if (project === null) return null;
  if (selection.kind === 'terminal') return offline === null ? <TerminalPage /> : <OfflinePanel onRetry={offline.retry} />;
  return (
    <Frame sidebar={(closeMenu) => <AgentSidebar project={project} selection={selection} onSelect={closeMenu} offline={offline !== null} />} onLock={onLock}>
      {offline !== null && !worksOffline(selection.kind) ? <OfflinePanel onRetry={offline.retry} /> : <AgentPanel selection={selection} />}
    </Frame>
  );
}
