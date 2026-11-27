import { type ReactNode } from 'react';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { currentOrganization } from '@metro-labs/client/auth/org-route';
import { routeHash } from '@metro-labs/client/route';
import { Icon } from '../Icon.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { Wide } from '../ui/Layout.js';
import { PageHeader } from '../ui/PageHeader.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { ActivityOverview } from './ActivityOverview.js';
import { useDocumentTitle } from '../../lib/title.js';

const FEED_HINT = 'Connector calls from all your agents, as they happen.';
const HOME_HINT = 'Connector calls from all your agents. Pick a connector on the left to see who uses it and what agents may do with it.';

const overviewKey = (agent: string | undefined): string => `${currentOrganization() ?? 'none'}:${agent ?? 'all'}`;

export function ActivityPage({ agent }: { agent?: string }): ReactNode {
  useDocumentTitle('Live activity');
  return (
    <Wide gap={24}>
      <PageHeader title="Live activity" subtitle={FEED_HINT} />
      <ActivityOverview key={overviewKey(agent)} agent={agent ?? null} full />
    </Wide>
  );
}

export function ConnectorsActivity(): ReactNode {
  return (
    <Wide gap={24}>
      <PageHeader title="Activity" subtitle={HOME_HINT} />
      <ActivityOverview key={overviewKey(undefined)} full={false} />
    </Wide>
  );
}

export function ActivityLink(): ReactNode {
  const palette = useKitPalette();
  return (
    <Group>
      <Item title="Live activity" subtitle={FEED_HINT} leading={<Icon name="plug" size={ICON_SIZE.lg} color={palette.text} />} href={routeHash({ kind: 'activity' })} />
    </Group>
  );
}
