import { type ReactNode, useEffect, useState } from 'react';
import { applyRoute, currentSelection, routeHash, subscribeRoute } from '../route';
import { AgentPanel } from './AgentPanel';
import { AgentSidebar } from './AgentSidebar';
import { Shell } from './Shell';
import { selectionProject, type Selection } from './selection';
import { currentServer, storeDaemon, baseFromSegment, storedServerId, storeServerId } from '../auth/daemon';
import { useIsNarrow } from '../media';

interface FrameProps {
  project: string;
  subject: string;
  selection: Selection;
  onSelect: (next: Selection) => void;
  onLock: () => void;
}

function Frame({ project, subject, selection, onSelect, onLock }: FrameProps): ReactNode {
  const narrow = useIsNarrow();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!narrow) setMenuOpen(false);
  }, [narrow]);
  return (
    <Shell
      narrow={narrow}
      menuOpen={menuOpen}
      flush={selection.kind === 'terminal'}
      onOpenMenu={() => {
        setMenuOpen(true);
      }}
      onCloseMenu={() => {
        setMenuOpen(false);
      }}
      sidebar={
        <AgentSidebar
          project={project}
          selection={selection}
          subject={subject}
          onSelect={(next) => {
            setMenuOpen(false);
            onSelect(next);
          }}
          onLock={onLock}
        />
      }
    >
      <AgentPanel selection={selection} onSelect={onSelect} />
    </Shell>
  );
}

interface DashboardProps {
  subject: string;
  onLock: () => void;
}

export function Dashboard({ subject, onLock }: DashboardProps): ReactNode {
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
  return <Frame project={project} subject={subject} selection={selection} onSelect={onSelect} onLock={onLock} />;
}
