import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TopBar } from './TopBar.js';
import { Drawer, DRAWER_WIDTH } from './Drawer.js';
import { PageScroll } from './PageScroll.js';
import { AccountMenu } from './AccountMenu.js';
import { OrganizationSwitcher } from './OrganizationSwitcher.js';
import { useSwipeDrawer } from './swipe.js';
import { side } from './ui/edges.js';
import { useIsNarrow } from '../lib/media.js';
import { webOnly } from '../lib/style.js';

const styles = StyleSheet.create({ fill: { flex: 1 } });
const STICKY = webOnly({ position: 'sticky', top: 0, height: '100vh' });
const PAGE_PAD = { x: 18, top: 18, bottom: 64 } as const;

function SidebarBody({ sidebar, onLock, close }: { sidebar: (close: () => void) => ReactNode; onLock: () => void; close: () => void }): ReactNode {
  const palette = useKitPalette();
  const line = side(palette.border);
  return (
    <>
      <Col padding={{ x: 18, y: 12 }} border={{ bottom: line }}>
        <OrganizationSwitcher onNavigate={close} />
      </Col>
      <Col flex={1} minHeight={0}>
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
  const swipe = useSwipeDrawer(narrow, menuOpen, setMenuOpen);
  const page = (
    <PageScroll>
      <Col gap={24} padding={{ ...PAGE_PAD, bottom: PAGE_PAD.bottom + insets.bottom }}>
        {children}
      </Col>
    </PageScroll>
  );
  if (narrow)
    return (
      <View style={styles.fill} {...swipe}>
        <TopBar
          onOpenMenu={() => {
            setMenuOpen(true);
          }}
        />
        {page}
        <Drawer open={menuOpen} onClose={close} swipe={swipe}>
          <SidebarBody sidebar={sidebar} onLock={onLock} close={close} />
        </Drawer>
      </View>
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
