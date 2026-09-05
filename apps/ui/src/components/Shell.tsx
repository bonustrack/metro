import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { TopBar } from './TopBar';

const PAGE = {
  width: '100%',
  paddingHorizontal: 32,
  paddingTop: 24,
  paddingBottom: 64,
} as const;
const FLUSH = { width: '100%' } as const;

interface ShellProps {
  narrow: boolean;
  menuOpen: boolean;
  flush?: boolean;
  onOpenMenu: () => void;
  onCloseMenu: () => void;
  sidebar: ReactNode;
  children: ReactNode;
}

export function Shell({
  narrow,
  menuOpen,
  flush = false,
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
        <Col gap={24} style={flush ? FLUSH : PAGE}>
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
