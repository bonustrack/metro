import { useState, type ReactNode } from 'react';
import { useWindowDimensions } from 'react-native';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Modal } from '../Modal.js';
import { Text } from '@stage-labs/kit/react-native/text';
import { RunActivity } from './Activity.js';
import { RunFiltersBar } from './FilterBar.js';
import { RunInspector } from './Inspector.js';
import { RunTrends } from './Trends.js';
import { DEFAULT_FILTERS, filterEntries, type EventBucket, type RunFilters } from './filters.js';
import type { RunEntry } from './model.js';

interface Props {
  entries: RunEntry[];
  now: number;
  notice: ReactNode;
  initialWorker?: string;
}

function useTimeline(entries: RunEntry[], now: number, initialWorker: string) {
  const [filters, setFilters] = useState<RunFilters>(() => ({ ...DEFAULT_FILTERS, worker: initialWorker }));
  const [more, setMore] = useState(false);
  const [limit, setLimit] = useState(20);
  const [bucket, setBucket] = useState<EventBucket | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspect, setInspect] = useState(false);
  const rows = filterEntries(entries, filters, now);
  const filtered = bucket === null ? rows : rows.filter((entry) => entry.at >= bucket.start && entry.at < bucket.end);
  const selected = entries.find((entry) => entry.id === selectedId);
  return {
    filters, more, limit, bucket, rows, filtered, selected, inspect,
    select: (id: string): void => { setSelectedId(id); setInspect(true); },
    reset: (): void => { setFilters(DEFAULT_FILTERS); setBucket(null); setLimit(20); },
    change: (key: keyof RunFilters, value: string): void => { setFilters((current) => ({ ...current, [key]: value })); setLimit(20); },
    toggleMore: (): void => { setMore(!more); },
    selectBucket: (value: EventBucket | null): void => { setBucket(value); setLimit(20); },
    loadMore: (): void => { setLimit(limit + 20); },
    close: (): void => { setInspect(false); },
  };
}

function Details({ selected, entries, filtered, narrow, inspect, onSelect, onClose }: {
  selected: RunEntry | undefined; entries: RunEntry[]; filtered: RunEntry[];
  narrow: boolean; inspect: boolean; onSelect: (id: string) => void; onClose: () => void;
}): ReactNode {
  const content = selected === undefined ? <Text size="sm" role="secondary">Select an event to see its details and links.</Text>
    : <RunInspector key={selected.id} entry={selected} entries={entries} onSelect={onSelect} visible={filtered.some((entry) => entry.id === selected.id)} />;
  return <Modal open={inspect && selected !== undefined} onClose={onClose} title="Event details" side={narrow ? 'bottom' : 'center'}>{content}</Modal>;
}

export function RunTimeline({ entries, now, notice, initialWorker = 'All' }: Props): ReactNode {
  const narrow = useWindowDimensions().width < 700;
  const data = useTimeline(entries, now, initialWorker);
  const [charts, setCharts] = useState(false);
  return <Col gap={16}>
      <Row justify="between" align="center" wrap gap={8}>
        <Row align="center" gap={8}><Text size="xs" role="secondary">Activity</Text><Badge label={String(data.filtered.length)} /></Row>
        <Row align="center" gap={12}><Text size="xs" role="secondary">Newest first · UTC</Text>
          <Text size="xs" onPress={() => { setCharts(!charts); }} accessibilityRole="button" accessibilityState={{ expanded: charts }}>{charts ? 'Hide charts' : 'Charts'}</Text></Row>
      </Row>
      {notice}
      <RunFiltersBar entries={entries} filters={data.filters} onChange={data.change} more={data.more} onMore={data.toggleMore} minute={data.bucket?.start ?? null} onReset={data.reset} narrow={narrow} />
      {charts && <RunTrends entries={data.rows} selected={data.bucket} onSelect={data.selectBucket} />}
      <RunActivity entries={data.filtered} onSelect={data.select} limit={data.limit} onMore={data.loadMore} onReset={data.reset} />
      <Text size="xs" role="secondary">Partial history: the last 500 Metro events, 40 SDK events and recent failures.</Text>
    <Details selected={data.selected} entries={entries} filtered={data.filtered} narrow={narrow} inspect={data.inspect} onSelect={data.select} onClose={data.close} />
  </Col>;
}
