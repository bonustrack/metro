import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import type { Server } from '@metro-labs/client/api/servers';
import { currentOrganization } from '@metro-labs/client/auth/org-route';
import { Icon } from '../Icon.js';
import { ErrorState } from '../ui/ErrorState.js';
import { Rows } from '../ui/Group.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { ActivityRow } from './ActivityRow.js';
import { useActivityFeed, useFreshIds, type ActivityFeedView, type CallFilter } from '../../lib/activity-feed.js';
import { emptyCalls } from '../../lib/call-stats.js';
import { scrollPageToTop } from '../../lib/page-scroll.js';
import { useServersQuery } from '../../lib/queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useNow } from '../../lib/use-now.js';
import { webOnly } from '../../lib/style.js';

const styles = StyleSheet.create({
  notice: { height: 0, alignSelf: 'stretch', zIndex: 3 },
  floating: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center', pointerEvents: 'box-none' },
});

const STICKY_NOTICE = webOnly({ position: 'sticky', top: 16 });
const NOTICE = StyleSheet.flatten([styles.notice, STICKY_NOTICE]);

function NewCalls({ count }: { count: number }): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  if (count === 0) return null;
  const label = count === 1 ? '1 new call' : `${String(count)} new calls`;
  return (
    <View style={NOTICE}>
      <View style={styles.floating}>
        <View>
          <Button size="sm" color="primary" dark={dark} label={label} icon={<Icon name="arrowUp" size={ICON_SIZE.sm} color={palette.bg} />} onPress={scrollPageToTop} />
        </View>
      </View>
    </View>
  );
}

function Earlier({ earlier }: { earlier: ActivityFeedView['earlier'] }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={8} align="start" margin={{ top: 16 }}>
      <Button size="md" color="secondary" dark={dark} label="Show earlier" loading={earlier.busy} disabled={earlier.busy} onPress={earlier.load} />
      {earlier.error === null ? null : <Text size="xs" role="danger">{earlier.error}</Text>}
    </Col>
  );
}

function Calls({ feed, servers, fixed, empty }: { feed: ActivityFeedView; servers: Server[]; fixed: boolean; empty: string }): ReactNode {
  const now = useNow();
  const technical = useTechnicalDetails();
  const fresh = useFreshIds(feed.calls, feed.loaded);
  const byId = new Map(servers.map((server) => [server.id, server]));
  if (feed.calls.length === 0)
    return (
      <Text size="md" role="secondary">
        {empty}
      </Text>
    );
  return (
    <Col>
      <Rows>
        {feed.calls.map((call) => (
          <ActivityRow key={call.id} call={call} server={byId.get(call.agent)} now={now} technical={technical} fresh={fresh.has(call.id)} showAgent={!fixed} />
        ))}
      </Rows>
      {feed.complete ? null : <Earlier earlier={feed.earlier} />}
    </Col>
  );
}

function Feed({ filter, servers, fixed }: { filter: CallFilter; servers: Server[]; fixed: boolean }): ReactNode {
  const feed = useActivityFeed(filter);
  if (feed.error !== null) return <ErrorState title="Could not read the activity" text={feed.error} onRetry={feed.retry} />;
  if (!feed.loaded) return <RowsSkeleton rows={5} />;
  return (
    <Col>
      <NewCalls count={feed.waiting} />
      <Calls feed={feed} servers={servers} fixed={fixed} empty={emptyCalls(filter.connector)} />
    </Col>
  );
}

export function ActivityFeed({ agent, connector = null, fixed = false }: { agent: string | null; connector?: string | null; fixed?: boolean }): ReactNode {
  const servers = useServersQuery().data ?? [];
  const filter = { agent, connector };
  return <Feed key={`${currentOrganization() ?? 'none'}:${agent ?? 'all'}:${connector ?? 'all'}`} filter={filter} servers={servers} fixed={fixed} />;
}
