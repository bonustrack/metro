import { type ReactNode, useEffect, useState } from 'react';
import { Shell } from './Shell.js';
import { AccountMenu } from './AccountMenu.js';
import { OrganizationSwitcher } from './OrganizationSwitcher.js';
import { useIsNarrow } from '../media.js';
import { useSwipeDrawer } from './swipe.js';

interface FrameProps {
  sidebar: (closeMenu: () => void) => ReactNode;
  onLock: () => void;
  children: ReactNode;
}

export function Frame({ sidebar, onLock, children }: FrameProps): ReactNode {
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
      onOpenMenu={() => {
        setMenuOpen(true);
      }}
      onCloseMenu={closeMenu}
      sidebar={
        <>
          <div className="side-top">
            <OrganizationSwitcher />
          </div>
          <div className="side-main">{sidebar(closeMenu)}</div>
          <div className="side-bottom">
            <AccountMenu onLock={onLock} />
          </div>
        </>
      }
    >
      {children}
    </Shell>
  );
}
