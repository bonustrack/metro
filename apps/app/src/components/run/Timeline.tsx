import { useState, type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Card } from '@stage-labs/kit/react-native/card';
import { Modal } from '../Modal.js';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { RunActivity } from './Activity.js';
import { RunFiltersBar } from './FilterBar.js';
import { RunInspector } from './Inspector.js';
import { RunTrends } from './Trends.js';
import { DEFAULT_FILTERS, filterEntries, type EventBucket, type RunFilters } from './filters.js';
import type { RunEntry } from './model.js';

const styles = StyleSheet.create({ feed: { flex: 1, minWidth: 0 }, inspector: { width: 320, flexShrink: 0, alignSelf: 'flex-start' } });

interface Props {
  entries: RunEntry[];
  now: number;
  notice: ReactNode;
  initialWorker?: string;
}

function useTimeline(entries: RunEntry[], now: number, split: boolean, initialWorker: string) {
  const [filters, setFilters] = useState<RunFilters>(() => ({ ...DEFAULT_FILTERS, worker: initialWorker }));
  const [more, setMore] = useState(false);
  const [limit, setLimit] = useState(20);
  const [bucket, setBucket] = useState<EventBucket | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspect, setInspect] = useState(false);
  const rows = filterEntries(entries, filters, now);
  const filtered = bucket === null ? rows : rows.filter((entry) => entry.at >= bucket.start && entry.at < bucket.end);
  const selected = entries.find((entry) => entry.id === selectedId) ?? (split ? filtered[0] : undefined);
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

function Details({ selected, entries, filtered, split, narrow, inspect, onSelect, onClose }: {
  selected: RunEntry | undefined; entries: RunEntry[]; filtered: RunEntry[];
  split: boolean; narrow: boolean; inspect: boolean; onSelect: (id: string) => void; onClose: () => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  const content = selected === undefined ? <Text size="sm" role="secondary">Select an event to see its details and verified links.</Text>
    : <RunInspector key={selected.id} entry={selected} entries={entries} onSelect={onSelect} visible={filtered.some((entry) => entry.id === selected.id)} />;
  if (split) return <Col style={styles.inspector} gap={14}>
    <Text weight="semibold">Event details</Text><Card dark={dark}>{content}</Card>
  </Col>;
  return <Modal open={inspect && selected !== undefined} onClose={onClose} title="Event details" side={narrow ? 'bottom' : 'center'}>{content}</Modal>;
}

export function RunTimeline({ entries, now, notice, initialWorker = 'All' }: Props): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { width } = useWindowDimensions();
  const split = width >= 1360;
  const narrow = width < 700;
  const data = useTimeline(entries, now, split, initialWorker);
  const [charts, setCharts] = useState(false);
  return <Row align="start" gap={24}>
    <Col style={styles.feed} gap={16}>
      <Row justify="between" align="center" wrap gap={8}>
        <Row align="center" gap={8}><Text weight="semibold">Activity</Text><Badge label={String(data.filtered.length)} /></Row>
        <Row align="center" gap={8}><Text size="2xs" role="secondary">Newest first · UTC</Text>
          <Button dark={dark} color="secondary" label={charts ? 'Hide charts' : 'Charts'} onPress={() => { setCharts(!charts); }} accessibilityState={{ expanded: charts }} /></Row>
      </Row>
      {notice}
      <RunFiltersBar entries={entries} filters={data.filters} onChange={data.change} more={data.more} onMore={data.toggleMore} minute={data.bucket?.start ?? null} onReset={data.reset} narrow={narrow} />
      {charts && <Card dark={dark}><RunTrends entries={data.rows} selected={data.bucket} onSelect={data.selectBucket} /></Card>}
      <RunActivity entries={data.filtered} selected={split ? data.selected?.id ?? null : null} onSelect={data.select} limit={data.limit} onMore={data.loadMore} onReset={data.reset} />
      <Text size="2xs" role="secondary">Partial history. Up to 500 Metro events across this box and 40 SDK lifecycle events in the latest snapshot, plus retained failures. No hidden reasoning.</Text>
    </Col>
    <Details selected={data.selected} entries={entries} filtered={data.filtered} split={split} narrow={narrow} inspect={data.inspect} onSelect={data.select} onClose={data.close} />
  </Row>;
}
