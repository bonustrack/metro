import { type ReactNode, useEffect, useState } from 'react';
import { Shell } from './Shell.js';
import { useIsNarrow } from '../media.js';

interface FrameProps {
  flush?: boolean;
  sidebar: (closeMenu: () => void) => ReactNode;
  children: ReactNode;
}

export function Frame({ flush = false, sidebar, children }: FrameProps): ReactNode {
  const narrow = useIsNarrow();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!narrow) setMenuOpen(false);
  }, [narrow]);
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
      sidebar={sidebar(closeMenu)}
    >
      {children}
    </Shell>
  );
}
