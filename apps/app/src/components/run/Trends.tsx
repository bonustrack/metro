import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Box, Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Tabs } from '@stage-labs/kit/react-native/tabs';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { eventBuckets, type EventBucket } from './filters.js';
import { clock, sameTimeRange, stamp, type RunEntry } from './model.js';

const styles = StyleSheet.create({ target: { flex: 1, minWidth: 0, height: 76, justifyContent: 'flex-end', alignItems: 'center' }, plot: { flex: 1, minWidth: 0 }, marker: { borderTopLeftRadius: 4, borderTopRightRadius: 4 } });
const bucketLabel = (row: EventBucket): string => `${stamp(row.start)} to ${clock(row.end)} UTC: ${String(row.count)} retained events`;
const bucketAction = (row: EventBucket, selected: EventBucket | null): string => `${bucketLabel(row)}. Filter this interval.${sameTimeRange(selected, row) ? ' Selected. Select again to clear.' : ''}`;

interface PlotProps {
  buckets: EventBucket[];
  selected: EventBucket | null;
  onSelect: (bucket: EventBucket | null) => void;
}

function EventPlot({ buckets, selected, onSelect }: PlotProps): ReactNode {
  const palette = useKitPalette();
  const [hovered, setHovered] = useState<EventBucket | null>(null);
  const max = Math.max(1, ...buckets.map((row) => row.count));
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  if (first === undefined || last === undefined) return <Text size="sm" role="secondary">No events match these filters.</Text>;
  return <Col gap={6}>
    <Row gap={10} align="end">
      <Col height={76} justify="between"><Text size="2xs">{max}</Text><Text size="2xs">0</Text></Col>
      <Row gap={3} style={styles.plot} border={{ bottom: { width: 1, color: palette.border } }}>
        {buckets.map((bucket) => <Pressable key={bucket.start} style={styles.target} accessibilityRole="button"
          accessibilityLabel={bucketAction(bucket, selected)} accessibilityState={{ selected: sameTimeRange(selected, bucket) }}
          onHoverIn={() => { setHovered(bucket); }} onHoverOut={() => { setHovered(null); }} onFocus={() => { setHovered(bucket); }} onBlur={() => { setHovered(null); }}
          onPress={() => { onSelect(sameTimeRange(selected, bucket) ? null : bucket); }} testID={`chart-bucket-${String(bucket.start)}`}>
          <Box width="100%" height={76} background={sameTimeRange(selected, bucket) ? palette.inputBg : 'transparent'} align="center" justify="end">
            <Box width={8} height={bucket.count / max * 68} background={palette.link} style={styles.marker} />
          </Box>
        </Pressable>)}
      </Row>
    </Row>
    <Row justify="between"><Text size="2xs">{clock(first.start)}</Text><Text size="2xs">{clock(last.end)} UTC</Text></Row>
    <Text size="2xs" accessibilityLiveRegion="polite">{hovered === null ? `Retained events per ${String((first.end - first.start) / 60_000)} minute interval. Select a bar to filter.` : bucketLabel(hovered)}</Text>
  </Col>;
}

export function RunTrends({ entries, selected, onSelect }: { entries: RunEntry[]; selected: EventBucket | null; onSelect: PlotProps['onSelect'] }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [mode, setMode] = useState('events');
  const [table, setTable] = useState(false);
  const buckets = eventBuckets(entries);
  return <Col gap={12} testID="run-charts">
    <Row gap={8} align="center" justify="between" wrap>
      <Tabs variant="underline" value={mode} options={[{ value: 'events', label: 'Events' }, { value: 'workers', label: 'Workers' }, { value: 'cost', label: 'Cost' }]} onChange={setMode} />
      {mode === 'events' && <Button dark={dark} color="secondary" label={table ? 'Hide table' : 'Show table'} onPress={() => { setTable(!table); }} />}
    </Row>
    {mode === 'events' ? <>
      <EventPlot buckets={buckets} selected={selected} onSelect={onSelect} />
      {table && <Col gap={6} testID="chart-table">{buckets.map((bucket) => <Button key={bucket.start} dark={dark} color="secondary"
        label={`${clock(bucket.start)} · ${String(bucket.count)} events`} accessibilityLabel={bucketLabel(bucket)}
        onPress={() => { onSelect(sameTimeRange(selected, bucket) ? null : bucket); }} />)}</Col>}
      <Text size="2xs" role="secondary">Filtered, partial history. Missing or expired events are not counted. Zero means no retained events, not proof of inactivity.</Text>
    </> : <Text size="sm" role="secondary">{mode === 'workers'
      ? 'Worker history is not exposed by the runner. The latest observed worker count appears above.'
      : 'Session cost is not exposed by the activity API. Provider usage on the Model page is a different scope.'}</Text>}
  </Col>;
}
