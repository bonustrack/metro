import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Box, Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Input } from '@stage-labs/kit/react-native/input';
import { Tabs } from '@stage-labs/kit/react-native/tabs';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Dropdown } from '../Dropdown.js';
import { DIMENSIONS, LABELS, filterCount, filterOptions, type Dimension, type RunFilters } from './filters.js';
import { short, stamp, type RunEntry } from './model.js';

const styles = StyleSheet.create({ search: { flex: 1, minWidth: 160 } });

interface Props {
  entries: RunEntry[];
  filters: RunFilters;
  onChange: (key: keyof RunFilters, value: string) => void;
  more: boolean;
  onMore: () => void;
  minute: number | null;
  onReset: () => void;
  narrow: boolean;
}

function FilterMenu({ dimension, entries, filters, onChange }: Pick<Props, 'entries' | 'filters' | 'onChange'> & { dimension: Dimension }): ReactNode {
  const options = filterOptions(entries, dimension);
  const value = filters[dimension];
  const current = options.find((option) => option.value === value);
  return <Dropdown label={`Filter ${LABELS[dimension]}`} button={{ label: short(current?.label ?? value, 28), color: 'secondary' }} items={options.map((option) => ({
    label: option.label, selected: option.value === value, onSelect: () => { onChange(dimension, option.value); },
  }))} />;
}

export function RunFiltersBar({ entries, filters, onChange, more, onMore, minute, onReset, narrow }: Props): ReactNode {
  const dark = useKitScheme() === 'dark';
  const count = filterCount(filters) + (minute === null ? 0 : 1);
  const menu = (dimension: Dimension): ReactNode => <FilterMenu key={dimension} dimension={dimension} entries={entries} filters={filters} onChange={onChange} />;
  return <Col gap={12} testID="run-filters">
    <Row gap={8} wrap align="center">
      <Box style={styles.search}><Input dark={dark} value={filters.q} onChangeText={(value) => { onChange('q', value); }}
        placeholder={narrow ? 'Search activity' : 'Search messages, people or tools'} inputProps={{ accessibilityLabel: 'Search activity', testID: 'activity-search' }} /></Box>
      <Button dark={dark} color="secondary" label={`Filters${count > 0 ? ` (${String(count)})` : ''}`} onPress={onMore} accessibilityState={{ expanded: more }} />
      {!narrow && menu('time')}
    </Row>
    <Row align="center" justify="between" wrap gap={12}>
      <Tabs variant="underline" value={filters.kind} options={[
        { value: 'All', label: 'All' }, { value: 'Message', label: 'Messages' },
        { value: 'Tool', label: 'Tools' }, { value: 'Error', label: 'Errors' },
      ]} onChange={(value) => { onChange('kind', value); }} />
      {!narrow && <Row gap={8} wrap>{menu('station')}{menu('channel')}</Row>}
    </Row>
    {more && <Col gap={12}>
      <Row gap={8} wrap>{DIMENSIONS.filter((key) => narrow || !['station', 'channel', 'time'].includes(key)).map(menu)}</Row>
      <Text size="2xs" role="secondary">Filters combine. Metro messages have no verified worker link.</Text>
    </Col>}
    {count > 0 && <Row gap={12} align="center" wrap>
      <Text size="2xs" role="secondary">{minute === null ? '' : `${stamp(minute)} · `}{count} active {count === 1 ? 'filter' : 'filters'}</Text>
      <Button dark={dark} color="secondary" variant="ghost" label="Clear filters" onPress={onReset} />
    </Row>}
  </Col>;
}
