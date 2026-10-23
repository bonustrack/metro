import { type ReactNode, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { DEFAULT_STATS_RANGE, STATS_RANGES, type ConnectorStats, type StatsConnector, type StatsRange } from '@metro-labs/client/api/connector-stats';
import { Choice } from '../Choice.js';
import { GroupTitle } from '../ui/Group.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { CallChart } from './CallChart.js';
import { CallLegend, CallTable } from './CallLegend.js';
import { CallTiles } from './CallTiles.js';
import { ConnectorBreakdown } from './ConnectorBreakdown.js';
import { callsWords, percentWords, perWords, rangeWords, stackSeries, statTiles, type ChartMode, type StackSeries } from '../../lib/call-stats.js';
import { useConnectorOrder, useConnectorStats } from '../../lib/call-stats-query.js';
import { useIsNarrow } from '../../lib/media.js';
import { SERIES_COLORS } from '../../lib/theme.js';

const MODES: { value: ChartMode; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'connector', label: 'By connector' },
];

const styles = StyleSheet.create({ dim: { opacity: 0.5 } });

interface CallStatsProps {
  agent: string | null;
  picked: StatsConnector | null;
  onPick: (connector: StatsConnector | null) => void;
}

function useSeries(stats: ConnectorStats, mode: ChartMode): StackSeries[] {
  const palette = useKitPalette();
  const order = useConnectorOrder();
  return stackSeries(stats, mode, { slots: SERIES_COLORS, other: palette.sub, calls: SERIES_COLORS[0] ?? palette.link, failed: palette.danger }, order);
}

function Chart({ stats, mode, onMode }: { stats: ConnectorStats; mode: ChartMode; onMode: (mode: ChartMode) => void }): ReactNode {
  const series = useSeries(stats, mode);
  const summary = `${callsWords(stats.totals.total)} ${rangeWords(stats.range)}, ${percentWords(stats.totals.failed, stats.totals.total)} failed`;
  return (
    <Col gap={12}>
      <Row justify="between" align="center" gap={12} wrap>
        <Text size="xs" role="secondary">
          {perWords(stats.range)}
        </Text>
        <Choice label="Chart" value={mode} options={MODES} onChange={onMode} />
      </Row>
      <CallChart series={series} times={stats.buckets.map((bucket) => bucket.at)} bucketMs={stats.bucketMs} range={stats.range} summary={summary} />
      <CallLegend series={series} />
      <CallTable stats={stats} />
    </Col>
  );
}

function Body({ stats, picked, onPick }: { stats: ConnectorStats; picked: StatsConnector | null; onPick: CallStatsProps['onPick'] }): ReactNode {
  const [mode, setMode] = useState<ChartMode>('all');
  const series = useSeries(stats, 'connector');
  if (stats.totals.total === 0)
    return (
      <Text size="md" role="secondary">
        {`No ${picked === null ? 'connector calls' : 'calls to this connector'} ${rangeWords(stats.range)}.`}
      </Text>
    );
  const colors = mode === 'connector' ? new Map(series.map((one) => [one.key, one.color])) : null;
  return (
    <Col gap={32}>
      <CallTiles tiles={statTiles(stats.totals, stats.range)} />
      <Chart stats={stats} mode={mode} onMode={setMode} />
      <ConnectorBreakdown connectors={stats.connectors} colors={colors} picked={picked} onPick={onPick} />
    </Col>
  );
}

export function CallStats({ agent, picked, onPick }: CallStatsProps): ReactNode {
  const narrow = useIsNarrow();
  const [range, setRange] = useState<StatsRange>(DEFAULT_STATS_RANGE);
  const query = useConnectorStats({ range, agent, connector: picked?.key ?? null });
  const stats = query.data;
  if (stats === null || (stats === undefined && query.error !== null)) return null;
  const choice = <Choice label="Time range" value={range} options={STATS_RANGES} onChange={setRange} />;
  return (
    <Col gap={16}>
      <GroupTitle label="Connector calls" action={narrow ? undefined : choice} />
      {narrow ? choice : null}
      {stats === undefined ? (
        <RowsSkeleton rows={3} leading={false} />
      ) : (
        <View style={query.isPlaceholderData ? styles.dim : undefined}>
          <Body stats={stats} picked={picked} onPick={onPick} />
        </View>
      )}
    </Col>
  );
}
