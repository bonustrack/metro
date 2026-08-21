import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { TopBar } from './TopBar';

const PAGE = {
  width: '100%',
  paddingHorizontal: 32,
  paddingVertical: 24,
} as const;

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
        <div className={narrow ? 'app-drawer' : 'app-sidebar'}>{sidebar}</div>
      ) : null}
      <div className="app-main">
        {narrow ? <TopBar onOpenMenu={onOpenMenu} /> : null}
        <Col gap={24} style={PAGE}>
          {children}
        </Col>
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
