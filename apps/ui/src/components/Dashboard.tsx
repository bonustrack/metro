import { type ReactNode, useEffect, useState } from 'react';
import {
  applyRoute,
  currentSelection,
  routeHash,
  subscribeRoute,
} from '../route';
import { AgentPanel } from './AgentPanel';
import { AgentSidebar } from './AgentSidebar';
import { Shell } from './Shell';
import { type Selection } from './selection';
import { useIsNarrow } from '../media';

interface DashboardProps {
  token: string;
  email: string;
  onLock: () => void;
}

export function Dashboard({ token, email, onLock }: DashboardProps): ReactNode {
  const narrow = useIsNarrow();
  const [menuOpen, setMenuOpen] = useState(false);
  const [selection, setSelection] = useState<Selection>(currentSelection);
  const hash = routeHash(selection);

  useEffect(() => subscribeRoute(setSelection), []);
  useEffect(() => {
    if (!narrow) setMenuOpen(false);
  }, [narrow]);
  useEffect(() => {
    applyRoute(selection, true);
  }, [hash]);

  const onSelect = (next: Selection): void => {
    setMenuOpen(false);
    setSelection(next);
    applyRoute(next, false);
  };

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
          selection={selection}
          email={email}
          onSelect={onSelect}
          onLock={onLock}
        />
      }
    >
      <AgentPanel token={token} selection={selection} onSelect={onSelect} />
    </Shell>
  );
}
