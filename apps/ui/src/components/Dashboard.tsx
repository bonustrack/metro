import { type ReactNode, useEffect, useState } from 'react';
import { applyRoute, currentSelection, routeHash, subscribeRoute } from '../route.js';
import { AgentPanel } from './AgentPanel.js';
import { AgentSidebar } from './AgentSidebar.js';
import { Frame } from './Frame.js';
import { OfflinePanel, worksOffline } from './Offline.js';
import { selectionProject, type Selection } from './selection.js';
import { currentServer, storeDaemon, baseFromSegment, storedServerId, storeServerId } from '../auth/daemon.js';

interface FramedProps {
  project: string;
  selection: Selection;
  onSelect: (next: Selection) => void;
  onLock: () => void;
  offline: Offline | null;
}

function Framed({ project, selection, onSelect, onLock, offline }: FramedProps): ReactNode {
  return (
    <Frame
      selection={selection}
      flush={selection.kind === 'terminal'}
      sidebar={(closeMenu) => (
        <AgentSidebar
          project={project}
          selection={selection}
          onSelect={(next) => {
            closeMenu();
            onSelect(next);
          }}
          offline={offline !== null}
        />
      )}
      onLock={onLock}
    >
      {offline !== null && !worksOffline(selection.kind) ? <OfflinePanel onRetry={offline.retry} /> : <AgentPanel selection={selection} onSelect={onSelect} />}
    </Frame>
  );
}

interface Offline {
  retry: () => void;
}

interface DashboardProps {
  onLock: () => void;
  offline?: Offline | null;
}

export function Dashboard({ onLock, offline = null }: DashboardProps): ReactNode {
  const [selection, setSelection] = useState<Selection>(currentSelection);
  const hash = routeHash(selection);

  useEffect(() => subscribeRoute(setSelection), []);
  useEffect(() => {
    applyRoute(selection, true);
  }, [hash]);

  const onSelect = (next: Selection): void => {
    setSelection(next);
    applyRoute(next, false);
  };

  const routed = selectionProject(selection);
  const project = routed ?? storedServerId();

  useEffect(() => {
    const server = currentServer();
    if (routed === null || server === null) return;
    storeServerId(server.id);
    storeDaemon(baseFromSegment(server.host));
  }, [routed]);

  if (project === null) return null;
  return <Framed project={project} selection={selection} onSelect={onSelect} onLock={onLock} offline={offline} />;
}
