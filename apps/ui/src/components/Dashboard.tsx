import { type ReactNode, useEffect, useState } from 'react';
import {
  applyRoute,
  currentSelection,
  routeHash,
  subscribeRoute,
} from '../route';
import { AgentPanel } from './AgentPanel';
import { AgentSidebar } from './AgentSidebar';
import { BootLoading } from './BootLoading';
import { Shell } from './Shell';
import { selectionProject, type Selection } from './selection';
import { Authorize } from './Authorize';
import { rememberedProject } from '../api/projects';
import { useProjectsQuery } from '../api/queries';
import { storeProject } from '../auth/session';
import { useIsNarrow } from '../media';

interface FrameProps {
  token: string;
  project: string;
  email: string;
  selection: Selection;
  onSelect: (next: Selection) => void;
  onLock: () => void;
}

function Frame({
  token,
  project,
  email,
  selection,
  onSelect,
  onLock,
}: FrameProps): ReactNode {
  const narrow = useIsNarrow();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!narrow) setMenuOpen(false);
  }, [narrow]);
  return (
    <Shell
      narrow={narrow}
      menuOpen={menuOpen}
      onOpenMenu={() => {
        setMenuOpen(true);
      }}
      onCloseMenu={() => {
        setMenuOpen(false);
      }}
      sidebar={
        <AgentSidebar
          token={token}
          project={project}
          selection={selection}
          email={email}
          onSelect={(next) => {
            setMenuOpen(false);
            onSelect(next);
          }}
          onLock={onLock}
        />
      }
    >
      <AgentPanel token={token} selection={selection} onSelect={onSelect} />
    </Shell>
  );
}

interface DashboardProps {
  token: string;
  email: string;
  onLock: () => void;
}

export function Dashboard({ token, email, onLock }: DashboardProps): ReactNode {
  const [selection, setSelection] = useState<Selection>(currentSelection);
  const { data } = useProjectsQuery(token);
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
  const project = routed ?? rememberedProject(data);

  useEffect(() => {
    if (project !== null && selection.kind === 'none')
      onSelect({ kind: 'agents', project });
  }, [project, selection.kind]);
  useEffect(() => {
    if (routed !== null) storeProject(routed);
  }, [routed]);

  if (selection.kind === 'authorize')
    return <Authorize token={token} id={selection.id} />;
  if (project === null) return <BootLoading />;
  return (
    <Frame
      token={token}
      project={project}
      email={email}
      selection={selection}
      onSelect={onSelect}
      onLock={onLock}
    />
  );
}
