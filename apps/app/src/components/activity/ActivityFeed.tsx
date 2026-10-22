import { type ReactNode, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { currentOrganization } from '@metro-labs/client/auth/org-route';
import { Icon } from '../Icon.js';
import { ErrorState } from '../ui/ErrorState.js';
import { Rows } from '../ui/Group.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { ActivityRow } from './ActivityRow.js';
import { useActivityFeed, useFreshIds, type ActivityFeedView } from '../../lib/activity-feed.js';
import { scrollPageToTop } from '../../lib/page-scroll.js';
import { useServersQuery } from '../../lib/queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { selectedColor } from '../../lib/theme.js';
import { useNow } from '../../lib/use-now.js';
import { webOnly } from '../../lib/style.js';

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  notice: { height: 0, alignSelf: 'stretch', zIndex: 3 },
  floating: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center', pointerEvents: 'box-none' },
});

const STICKY_NOTICE = webOnly({ position: 'sticky', top: 16 });
const NOTICE = StyleSheet.flatten([styles.notice, STICKY_NOTICE]);

function Chips({ servers, value, onChange }: { servers: Server[]; value: string | null; onChange: (agent: string | null) => void }): ReactNode {
  const palette = useKitPalette();
  if (servers.length < 2) return null;
  const choices: { id: string | null; label: string }[] = [{ id: null, label: 'All agents' }, ...servers.map((server) => ({ id: server.id, label: serverLabel(server) }))];
  return (
    <Row gap={4} wrap>
      {choices.map((choice) => {
        const on = choice.id === value;
        const frame = StyleSheet.flatten([styles.chip, on ? { backgroundColor: selectedColor(palette) } : null]);
        return (
          <Pressable key={choice.id ?? 'all'} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => { onChange(choice.id); }} style={frame}>
            <Text size="md" role={on ? 'default' : 'secondary'} numberOfLines={1}>{choice.label}</Text>
          </Pressable>
        );
      })}
    </Row>
  );
}

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

function Calls({ feed, servers, fixed }: { feed: ActivityFeedView; servers: Server[]; fixed: boolean }): ReactNode {
  const now = useNow();
  const technical = useTechnicalDetails();
  const fresh = useFreshIds(feed.calls, feed.loaded);
  const byId = new Map(servers.map((server) => [server.id, server]));
  if (feed.calls.length === 0)
    return (
      <Text size="md" role="secondary">
        No connector calls yet. Calls appear here as your agents use their connectors.
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

function Feed({ agent, servers, fixed }: { agent: string | null; servers: Server[]; fixed: boolean }): ReactNode {
  const feed = useActivityFeed(agent);
  if (feed.error !== null) return <ErrorState title="Could not read the activity" text={feed.error} onRetry={feed.retry} />;
  if (!feed.loaded) return <RowsSkeleton rows={5} />;
  return (
    <Col>
      <NewCalls count={feed.waiting} />
      <Calls feed={feed} servers={servers} fixed={fixed} />
    </Col>
  );
}

function shownAgent(agent: string | null, fixed: boolean, known: Server[] | undefined): string | null {
  if (agent === null || fixed || known === undefined) return agent;
  return known.some((server) => server.id === agent) ? agent : null;
}

export function ActivityFeed({ agent: picked = null, fixed = false }: { agent?: string | null; fixed?: boolean }): ReactNode {
  const known = useServersQuery().data;
  const servers = known ?? [];
  const [agent, setAgent] = useState<string | null>(picked);
  const shown = shownAgent(agent, fixed, known);
  return (
    <Col gap={20} width="100%">
      {fixed ? null : <Chips servers={servers} value={shown} onChange={setAgent} />}
      <Feed key={`${currentOrganization() ?? 'none'}:${shown ?? 'all'}`} agent={shown} servers={servers} fixed={fixed} />
    </Col>
  );
}
