import { useState, type ReactNode } from 'react';
import { useWindowDimensions } from 'react-native';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { RunActivity } from './Activity.js';
import { RunFiltersBar } from './FilterBar.js';
import { RunTrends } from './Trends.js';
import { DEFAULT_FILTERS, filterEntries, type EventBucket, type RunFilters } from './filters.js';
import type { RunEntry } from './model.js';
import { useTechnicalDetails } from '../../lib/technical.js';

export function useTimeline(entries: RunEntry[], now: number, initialWorker: string) {
  const [filters, setFilters] = useState<RunFilters>(() => ({ ...DEFAULT_FILTERS, worker: initialWorker }));
  const [more, setMore] = useState(false);
  const [limit, setLimit] = useState(20);
  const [bucket, setBucket] = useState<EventBucket | null>(null);
  const rows = filterEntries(entries, filters, now);
  const filtered = bucket === null ? rows : rows.filter((entry) => entry.at >= bucket.start && entry.at < bucket.end);
  return {
    filters, more, limit, bucket, rows, filtered,
    reset: (): void => { setFilters(DEFAULT_FILTERS); setBucket(null); setLimit(20); },
    change: (key: keyof RunFilters, value: string): void => { setFilters((current) => ({ ...current, [key]: value })); setLimit(20); },
    toggleMore: (): void => { setMore(!more); },
    selectBucket: (value: EventBucket | null): void => { setBucket(value); setLimit(20); },
    loadMore: (): void => { setLimit(limit + 20); },
  };
}

export type Timeline = ReturnType<typeof useTimeline>;

interface Props {
  data: Timeline;
  entries: RunEntry[];
  notice: ReactNode;
  onSelect: (id: string) => void;
}

export function RunTimeline({ data, entries, notice, onSelect }: Props): ReactNode {
  const narrow = useWindowDimensions().width < 700;
  const technical = useTechnicalDetails();
  const [charts, setCharts] = useState(false);
  return (
    <Col gap={16}>
      <Row justify="between" align="center" wrap gap={8}>
        <Row align="center" gap={8}>
          <Text size="xs" role="secondary">What happened</Text>
          <Badge label={String(data.filtered.length)} />
        </Row>
        <Row align="center" gap={12}>
          <Text size="xs" role="secondary">{technical ? 'Newest first · UTC' : 'Newest first'}</Text>
          <Text size="xs" onPress={() => { setCharts(!charts); }} accessibilityRole="button" accessibilityState={{ expanded: charts }}>{charts ? 'Hide charts' : 'Charts'}</Text>
        </Row>
      </Row>
      {notice}
      <RunFiltersBar entries={entries} filters={data.filters} onChange={data.change} more={data.more} onMore={data.toggleMore} minute={data.bucket?.start ?? null} onReset={data.reset} narrow={narrow} />
      {charts && <RunTrends entries={data.rows} selected={data.bucket} onSelect={data.selectBucket} />}
      <RunActivity entries={data.filtered} onSelect={onSelect} limit={data.limit} onMore={data.loadMore} onReset={data.reset} />
      <Text size="xs" role="secondary">{technical ? 'Partial history: the last 500 Metro events, 40 SDK events and recent failures.' : 'Only recent activity is kept.'}</Text>
    </Col>
  );
}
