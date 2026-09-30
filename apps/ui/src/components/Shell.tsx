import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { TopBar } from './TopBar.js';

interface ShellProps {
  narrow: boolean;
  menuOpen: boolean;
  onOpenMenu: () => void;
  onCloseMenu: () => void;
  sidebar: ReactNode;
  children: ReactNode;
}

export function Shell({
  narrow,
  menuOpen,
  onOpenMenu,
  onCloseMenu,
  sidebar,
  children,
}: ShellProps): ReactNode {
  return (
    <div className="app-shell">
      {!narrow || menuOpen ? (
        <div className={narrow ? 'app-drawer' : 'app-sidebar'}>
          <div className="app-sidebar-body">{sidebar}</div>
        </div>
      ) : null}
      <div className="app-main">
        {narrow ? <TopBar onOpenMenu={onOpenMenu} /> : null}
        <div className="page-content">
          <Col gap={24}>{children}</Col>
        </div>
      </div>
      {narrow && menuOpen ? (
        <button
          type="button"
          className="app-backdrop"
          aria-label="Close menu"
          onClick={onCloseMenu}
        />
      ) : null}
    </div>
  );
}
