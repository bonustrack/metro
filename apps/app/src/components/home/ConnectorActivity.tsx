import { type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { routeHash } from '@metro-labs/client/route';
import { Group } from '../ui/Group.js';
import { RouteLink } from '../RouteLink.js';
import { ActivityRow } from '../activity/ActivityRow.js';
import { CallSparkline } from '../activity/CallSparkline.js';
import { SectionLink } from './SectionParts.js';
import { useFreshIds, useLatestActivity } from '../../lib/activity-feed.js';
import { callsWords, countWords, failedAlarm, percentWords, rangeWords } from '../../lib/call-stats.js';
import { useConnectorStats } from '../../lib/call-stats-query.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useNow } from '../../lib/use-now.js';

const LABEL = 'Connector activity';

const styles = StyleSheet.create({
  week: { flexDirection: 'row', alignItems: 'center', gap: 24, paddingVertical: 14, borderBottomWidth: 1 },
});

function Figure({ label, value, danger = false }: { label: string; value: string; danger?: boolean }): ReactNode {
  return (
    <Col gap={2}>
      <Text size="xs" role="secondary" numberOfLines={1}>
        {label}
      </Text>
      <Text size="lg" weight="semibold" role={danger ? 'danger' : 'default'} numberOfLines={1}>
        {value}
      </Text>
    </Col>
  );
}

function Week({ agent, href }: { agent: string; href: string }): ReactNode {
  const palette = useKitPalette();
  const stats = useConnectorStats({ range: '7d', agent, connector: null }).data;
  if (stats === undefined || stats === null) return null;
  const { total, failed } = stats.totals;
  const frame = StyleSheet.flatten([styles.week, { borderBottomColor: palette.border }]);
  const failedShare = percentWords(failed, total);
  return (
    <RouteLink to={href} label={`${callsWords(total)} ${rangeWords('7d')}, ${failedShare} failed. Open the connector calls of this agent.`} style={frame}>
      <Figure label="Calls, 7 days" value={countWords(total)} />
      <Figure label="Failed" value={failedShare} danger={failedAlarm(failed, total)} />
      <Row flex={1} justify="end">
        <CallSparkline values={stats.buckets.map((bucket) => bucket.total)} label={`Calls per 6 hours ${rangeWords('7d')}`} />
      </Row>
    </RouteLink>
  );
}

export function ConnectorActivity({ agent }: { agent: string }): ReactNode {
  const calls = useLatestActivity({ agent, connector: null }).data ?? null;
  const now = useNow();
  const technical = useTechnicalDetails();
  const fresh = useFreshIds(calls ?? [], calls !== null);
  if (calls === null) return null;
  if (calls.length === 0)
    return (
      <Group label={LABEL} note="No connector calls yet." wide>
        {null}
      </Group>
    );
  const href = routeHash({ kind: 'activity', agent });
  return (
    <Group label={LABEL} wide action={<SectionLink to={href} label="Show all" />}>
      <Week agent={agent} href={href} />
      {calls.map((call) => (
        <ActivityRow key={call.id} call={call} now={now} technical={technical} fresh={fresh.has(call.id)} showAgent={false} />
      ))}
    </Group>
  );
}
