import { type ReactNode, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { DEFAULT_STATS_RANGE, STATS_RANGES, type StatsRange } from '@metro-labs/client/api/connector-stats';
import { dollarsWords, OTHER_CONNECTIONS, type ConnectionUsage, type ModelUsage } from '@metro-labs/client/api/gateway-usage';
import { routeHash } from '@metro-labs/client/route';
import { Choice } from '../Choice.js';
import { CallChart, type ChartUnits } from '../activity/CallChart.js';
import { CallLegend } from '../activity/CallLegend.js';
import { CallTiles } from '../activity/CallTiles.js';
import { Group, GroupTitle } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { countWords, rangeWords } from '../../lib/call-stats.js';
import { callWords, chartTitle, connectionName, usageMeasure, usageSeries, usageSummary, usageTiles } from '../../lib/gateway-usage.js';
import { useGatewayUsage } from '../../lib/gateway-usage-query.js';
import { useIsNarrow } from '../../lib/media.js';
import { SERIES_COLORS } from '../../lib/theme.js';

const styles = StyleSheet.create({ dim: { opacity: 0.5 } });

const SPEND_UNITS: ChartUnits = { value: dollarsWords, total: dollarsWords };
const CALL_UNITS: ChartUnits = { value: countWords, total: callWords };

function Chart({ usage }: { usage: ModelUsage }): ReactNode {
  const palette = useKitPalette();
  const measure = usageMeasure(usage);
  const series = usageSeries(usage, measure, { slots: SERIES_COLORS, other: palette.sub });
  return (
    <Column gap={12}>
      <Text size="xs" color="secondary">
        {chartTitle(measure, usage.range)}
      </Text>
      <CallChart series={series} times={usage.buckets.map((bucket) => bucket.at)} bucketMs={usage.bucketMs} range={usage.range} summary={usageSummary(usage)} units={measure === 'spend' ? SPEND_UNITS : CALL_UNITS} />
      <CallLegend series={series} />
    </Column>
  );
}

const accountHref = (row: ConnectionUsage): string | undefined =>
  row.connection === '' || row.connection === OTHER_CONNECTIONS || row.label === null ? undefined : routeHash({ kind: 'org-model', id: row.connection });

function ByAccount({ usage }: { usage: ModelUsage }): ReactNode {
  return (
    <Group label="By account" wide>
      {usage.connections.map((row) => (
        <Item key={row.connection} title={connectionName(row)} href={accountHref(row)} chevron={accountHref(row) !== undefined}
          subtitle={`${callWords(row.calls)} · ${countWords(row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens)} tokens in, ${countWords(row.outputTokens)} out${row.unpriced > 0 ? ' · not all priced' : ''}`}
          value={dollarsWords(row.spendMicros)} />
      ))}
    </Group>
  );
}

function ByAgent({ usage }: { usage: ModelUsage }): ReactNode {
  if (usage.agents.length === 0) return null;
  return (
    <Group label="By agent" wide>
      {usage.agents.map((row) => (
        <Item key={row.agent} title={row.name ?? 'Removed agent'} subtitle={callWords(row.calls)} value={dollarsWords(row.spendMicros)} chevron={false} />
      ))}
    </Group>
  );
}

interface Scope {
  agent: string | null;
  connection: string | null;
}

function Body({ usage, scope }: { usage: ModelUsage; scope: Scope }): ReactNode {
  if (usage.totals.calls === 0)
    return (
      <Text size="md" color="secondary">
        {`No model calls through gateway.metro.box ${rangeWords(usage.range)}.`}
      </Text>
    );
  return (
    <Column gap={32}>
      <CallTiles tiles={usageTiles(usage.totals, usage.range)} />
      <Chart usage={usage} />
      {scope.connection === null ? <ByAccount usage={usage} /> : null}
      {scope.agent === null ? <ByAgent usage={usage} /> : null}
    </Column>
  );
}

export function GatewayUsage({ agent, connection = null, label = 'Usage' }: { agent: string | null; connection?: string | null; label?: string }): ReactNode {
  const narrow = useIsNarrow();
  const [range, setRange] = useState<StatsRange>(DEFAULT_STATS_RANGE);
  const query = useGatewayUsage({ range, agent, connection });
  const usage = query.data;
  if (usage === null || (usage === undefined && query.error !== null)) return null;
  const choice = <Choice label="Time range" value={range} options={STATS_RANGES} onChange={setRange} />;
  return (
    <Column gap={16}>
      <GroupTitle label={label} action={narrow ? undefined : choice} />
      {narrow ? choice : null}
      {usage === undefined ? (
        <RowsSkeleton rows={3} leading={false} />
      ) : (
        <View style={query.isPlaceholderData ? styles.dim : undefined}>
          <Body usage={usage} scope={{ agent, connection }} />
        </View>
      )}
    </Column>
  );
}
