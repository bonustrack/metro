import { type ReactNode, useEffect, useState } from 'react';
import { Shell } from './Shell.js';
import { ServerRail } from './ServerRail.js';
import { type Selection } from './selection.js';
import { useIsNarrow } from '../media.js';
import { useSwipeDrawer } from './swipe.js';

interface FrameProps {
  selection: Selection;
  flush?: boolean;
  sidebar: (closeMenu: () => void) => ReactNode;
  onLock: () => void;
  children: ReactNode;
}

export function Frame({ selection, flush = false, sidebar, onLock, children }: FrameProps): ReactNode {
  const narrow = useIsNarrow();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!narrow) setMenuOpen(false);
  }, [narrow]);
  useSwipeDrawer(narrow, menuOpen, setMenuOpen);
  const closeMenu = (): void => {
    setMenuOpen(false);
  };
  return (
    <Shell
      narrow={narrow}
      menuOpen={menuOpen}
      flush={flush}
      onOpenMenu={() => {
        setMenuOpen(true);
      }}
      onCloseMenu={closeMenu}
      rail={<ServerRail selection={selection} onLock={onLock} />}
      sidebar={sidebar(closeMenu)}
    >
      {children}
    </Shell>
  );
}
