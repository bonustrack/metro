import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { routeHash } from '@metro-labs/client/route';
import { type Selection } from '@metro-labs/client/selection';
import { PageScroll } from '../PageScroll.js';
import { Crumbs } from '../ui/PageHeader.js';
import { Rail } from './Rail.js';
import { RailTipLayer } from './RailTipLayer.js';
import { TAB_BAR_ROOM, TabBar } from './TabBar.js';
import { isAdminSelection, phoneBackLabel, phoneBackOf, phoneTabOf, shellSectionOf } from '../../lib/shell-sections.js';
import { useIsNarrow } from '../../lib/media.js';
import { useServersQuery } from '../../lib/queries.js';
import { side } from '../ui/edges.js';
import { PAGE_PAD, PAGE_TOP, PHONE_PAD, WIDE_WIDTH } from '../ui/sizes.js';
import { webOnly } from '../../lib/style.js';

const LIST_WIDTH = 320;
const DETAIL_MAX = WIDE_WIDTH + 2 * PAGE_PAD;
const DETAIL_BOTTOM = 96;
const TAB_BAR_GAP = 16;

const STICKY_LIST = webOnly({ position: 'sticky', top: 0, height: '100vh', zIndex: 2 });
const FILL_VIEWPORT = webOnly({ minHeight: '100vh' });

interface AppShellProps {
  selection: Selection;
  onLock: () => void;
  list?: ReactNode;
  fluid?: boolean;
  dock?: boolean;
  children: ReactNode;
}

function DesktopShell({ selection, onLock, list, fluid = false, dock = false, children }: AppShellProps): ReactNode {
  const palette = useKitPalette();
  return (
    <Row weight={1} align="start">
      <Rail section={shellSectionOf(selection)} admin={isAdminSelection(selection)} onLock={onLock} />
      {list === undefined || list === null ? null : (
        <Column width={LIST_WIDTH} border={{ right: side(palette.border) }} style={STICKY_LIST}>
          {list}
        </Column>
      )}
      <Column weight={1} minWidth={0}>
        <PageScroll>
          <Column width="100%" maxWidth={fluid || dock ? undefined : DETAIL_MAX} gap={24} padding={dock ? undefined : { x: PAGE_PAD, top: PAGE_TOP, bottom: DETAIL_BOTTOM }} style={dock ? FILL_VIEWPORT : undefined}>
            {children}
          </Column>
        </PageScroll>
      </Column>
      <RailTipLayer />
    </Row>
  );
}

function PhoneBack({ selection }: { selection: Selection }): ReactNode {
  const servers = useServersQuery().data;
  const back = 'project' in selection ? null : phoneBackOf(selection);
  if (back === null) return null;
  return <Crumbs items={[{ label: phoneBackLabel(back, servers), href: routeHash(back) }]} />;
}

function PhoneShell({ selection, dock = false, children }: AppShellProps): ReactNode {
  const insets = useSafeAreaInsets();
  return (
    <Column weight={1}>
      <PageScroll>
        <Column gap={dock ? 0 : 24} padding={{ x: dock ? 0 : PHONE_PAD, top: insets.top + 6, bottom: dock ? insets.bottom : TAB_BAR_ROOM + insets.bottom }} style={dock ? FILL_VIEWPORT : undefined}>
          <Column padding={{ x: dock ? PHONE_PAD : 0 }}>
            <PhoneBack selection={selection} />
          </Column>
          {children}
        </Column>
      </PageScroll>
      {dock ? null : <TabBar active={phoneTabOf(selection)} bottom={insets.bottom + TAB_BAR_GAP} />}
    </Column>
  );
}

export function AppShell(props: AppShellProps): ReactNode {
  return useIsNarrow() ? <PhoneShell {...props} /> : <DesktopShell {...props} />;
}
