import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { routeHash } from '@metro-labs/client/route';
import { type Selection } from '@metro-labs/client/selection';
import { PageScroll } from '../PageScroll.js';
import { Crumbs } from '../ui/PageHeader.js';
import { Rail } from './Rail.js';
import { TAB_BAR_ROOM, TabBar } from './TabBar.js';
import { SHELL_SECTIONS, phoneBackOf, phoneTabOf, shellSectionOf } from '../../lib/shell-sections.js';
import { useIsNarrow } from '../../lib/media.js';
import { side } from '../ui/edges.js';
import { webOnly } from '../../lib/style.js';

const LIST_WIDTH = 320;
const DETAIL_MAX = 760;
const DETAIL_PAD = 40;
const PHONE_PAD = 20;
const TAB_BAR_GAP = 16;

const STICKY_LIST = webOnly({ position: 'sticky', top: 0, height: '100vh', zIndex: 2 });
const CENTERED = { alignSelf: 'center' } as const;

interface AppShellProps {
  selection: Selection;
  onLock: () => void;
  list?: ReactNode;
  children: ReactNode;
}

function DesktopShell({ selection, onLock, list, children }: AppShellProps): ReactNode {
  const palette = useKitPalette();
  return (
    <Row flex={1} align="start">
      <Rail section={shellSectionOf(selection)} onLock={onLock} />
      {list === undefined || list === null ? null : (
        <Col width={LIST_WIDTH} border={{ right: side(palette.border) }} style={STICKY_LIST}>
          {list}
        </Col>
      )}
      <Col flex={1} minWidth={0}>
        <PageScroll>
          <Col width="100%" maxWidth={DETAIL_MAX} gap={24} padding={{ x: DETAIL_PAD, top: 28, bottom: 96 }} style={CENTERED}>
            {children}
          </Col>
        </PageScroll>
      </Col>
    </Row>
  );
}

function PhoneBack({ selection }: { selection: Selection }): ReactNode {
  const back = 'project' in selection ? null : phoneBackOf(selection);
  if (back === null) return null;
  const label = SHELL_SECTIONS.find((s) => s.target.kind === back.kind)?.label ?? 'Back';
  return <Crumbs items={[{ label, href: routeHash(back) }]} />;
}

function PhoneShell({ selection, children }: AppShellProps): ReactNode {
  const insets = useSafeAreaInsets();
  return (
    <Col flex={1}>
      <PageScroll>
        <Col gap={24} padding={{ x: PHONE_PAD, top: insets.top + 6, bottom: TAB_BAR_ROOM + insets.bottom }}>
          <PhoneBack selection={selection} />
          {children}
        </Col>
      </PageScroll>
      <TabBar active={phoneTabOf(selection)} bottom={insets.bottom + TAB_BAR_GAP} />
    </Col>
  );
}

export function AppShell(props: AppShellProps): ReactNode {
  return useIsNarrow() ? <PhoneShell {...props} /> : <DesktopShell {...props} />;
}
