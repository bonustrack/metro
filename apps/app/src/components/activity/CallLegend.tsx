import { type ReactNode, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import type { ConnectorStats } from '@metro-labs/client/api/connector-stats';
import { ConnectorFavicon } from '../ConnectorFavicon.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { bucketWords, callsWords, countWords, type StackSeries } from '../../lib/call-stats.js';

const SWATCH = 10;

const styles = StyleSheet.create({
  swatch: { width: SWATCH, height: SWATCH, borderRadius: 2 },
});

export function Swatch({ color }: { color: string }): ReactNode {
  return <View style={StyleSheet.flatten([styles.swatch, { backgroundColor: color }])} />;
}

export function CallLegend({ series }: { series: StackSeries[] }): ReactNode {
  return (
    <Row gap={16} wrap align="center">
      {series.map((one) => (
        <Row key={one.key} gap={6} align="center">
          <Swatch color={one.color} />
          {one.url === null ? null : <ConnectorFavicon name={one.label} url={one.url} size={ICON_SIZE.sm} />}
          <Text size="xs" role="secondary" numberOfLines={1}>
            {one.label}
          </Text>
        </Row>
      ))}
    </Row>
  );
}

export function CallTable({ stats }: { stats: ConnectorStats }): ReactNode {
  const [open, setOpen] = useState(false);
  const rows = stats.buckets.filter((bucket) => bucket.total > 0).reverse();
  return (
    <Col gap={8} align="start">
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => { setOpen((shown) => !shown); }}>
        <Text size="xs" role="secondary">
          {open ? 'Hide the table' : 'Show as a table'}
        </Text>
      </Pressable>
      {open
        ? rows.map((bucket) => (
            <Text key={bucket.at} size="xs" numberOfLines={1}>
              {`${bucketWords(bucket.at, stats.bucketMs)}: ${callsWords(bucket.total)}, ${countWords(bucket.failed)} failed`}
            </Text>
          ))
        : null}
    </Col>
  );
}
