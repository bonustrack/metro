import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { currentSelection } from '@metro-labs/client/route';
import { NavRow } from './NavRow.js';
import { TopBar } from './TopBar.js';
import { Drawer } from './Drawer.js';
import { DRAWER_WIDTH } from './DrawerPanel.js';
import { PageScroll } from './PageScroll.js';
import { AccountMenu } from './AccountMenu.js';
import { OrganizationSwitcher } from './OrganizationSwitcher.js';
import { side } from './ui/edges.js';
import { useIsNarrow } from '../lib/media.js';
import { webOnly } from '../lib/style.js';

const STICKY = webOnly({ position: 'sticky', top: 0, height: '100vh' });
const PAGE_PAD = { x: 18, top: 18, bottom: 64 } as const;
const SMALL = 720;
const SMALL_TOP = 12;

function SidebarBody({ sidebar, onLock, close }: { sidebar: (close: () => void) => ReactNode; onLock: () => void; close: () => void }): ReactNode {
  const palette = useKitPalette();
  const line = side(palette.border);
  return (
    <>
      <Col padding={{ x: 18, y: 12 }} border={{ bottom: line }}>
        <OrganizationSwitcher onNavigate={close} />
      </Col>
      <Col flex={1} minHeight={0}>
        <Col padding={{ top: 12 }}>
          <NavRow label="All agents" icon="server" selected={currentSelection().kind === 'all-agents'} target={{ kind: 'all-agents' }} onSelect={close} />
        </Col>
        {sidebar(close)}
      </Col>
      <Col padding={{ x: 18, top: 12, bottom: 16 }} border={{ top: line }}>
        <AccountMenu onLock={onLock} onNavigate={close} />
      </Col>
    </>
  );
}

interface FrameProps {
  sidebar: (closeMenu: () => void) => ReactNode;
  onLock: () => void;
  children: ReactNode;
}

export function Frame({ sidebar, onLock, children }: FrameProps): ReactNode {
  const narrow = useIsNarrow();
  const palette = useKitPalette();
  const insets = useSafeAreaInsets();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!narrow) setMenuOpen(false);
  }, [narrow]);
  const close = useCallback(() => {
    setMenuOpen(false);
  }, []);
  const top = useWindowDimensions().width <= SMALL ? SMALL_TOP : PAGE_PAD.top;
  const page = (
    <PageScroll>
      <Col gap={24} padding={{ ...PAGE_PAD, top, bottom: PAGE_PAD.bottom + insets.bottom }}>
        {children}
      </Col>
    </PageScroll>
  );
  if (narrow)
    return (
      <Drawer open={menuOpen} onOpenChange={setMenuOpen} menu={<SidebarBody sidebar={sidebar} onLock={onLock} close={close} />}>
        <TopBar
          onOpenMenu={() => {
            setMenuOpen(true);
          }}
        />
        {page}
      </Drawer>
    );
  return (
    <Row flex={1} align="start">
      <Col width={DRAWER_WIDTH} surface="toolbar" border={{ right: side(palette.border) }} style={STICKY}>
        <SidebarBody sidebar={sidebar} onLock={onLock} close={close} />
      </Col>
      <Col flex={1} minWidth={0}>
        {page}
      </Col>
    </Row>
  );
}
