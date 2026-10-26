import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { TextField } from '@stage-labs/kit/react-native/text-field';
import { Button } from '@stage-labs/kit/react-native/button';
import { Tabs } from '@stage-labs/kit/react-native/tabs';
import { Text } from '@stage-labs/kit/react-native/text';
import { Dropdown } from '../Dropdown.js';
import { DIMENSIONS, LABELS, filterCount, filterOptions, type Dimension, type RunFilters } from './filters.js';
import { short, stamp, type RunEntry } from './model.js';
import { entryTime } from './words.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { optionTabs } from '../../lib/option-tabs.js';

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

function activeLine(minute: number | null, count: number, technical: boolean): string {
  const at = minute === null ? '' : `${technical ? stamp(minute) : entryTime(minute, false)} · `;
  return `${at}${String(count)} active ${count === 1 ? 'filter' : 'filters'}`;
}

export function RunFiltersBar({ entries, filters, onChange, more, onMore, minute, onReset, narrow }: Props): ReactNode {
  const technical = useTechnicalDetails();
  const count = filterCount(filters) + (minute === null ? 0 : 1);
  const menu = (dimension: Dimension): ReactNode => <FilterMenu key={dimension} dimension={dimension} entries={entries} filters={filters} onChange={onChange} />;
  return <Column gap={12} testID="run-filters">
    <Row gap={8} wrap align="center">
      <Column style={styles.search}><TextField value={filters.q} onChangeText={(value) => { onChange('q', value); }}
        placeholder={narrow ? 'Search activity' : 'Search messages, people or tools'} inputProps={{ accessibilityLabel: 'Search activity', testID: 'activity-search' }} /></Column>
      <Button color="secondary" label={`Filters${count > 0 ? ` (${String(count)})` : ''}`} onPress={onMore} accessibilityState={{ expanded: more }} />
      {!narrow && menu('time')}
    </Row>
    <Row align="center" justify="spaceBetween" wrap gap={12}>
      <Tabs variant="underline" {...optionTabs([
        { value: 'All', label: 'All' }, { value: 'Message', label: 'Messages' },
        { value: 'Tool', label: 'Tools' }, { value: 'Error', label: 'Errors' },
      ], filters.kind, (value) => { onChange('kind', value); })} />
      {!narrow && <Row gap={8} wrap>{menu('station')}{menu('channel')}</Row>}
    </Row>
    {more && <Column gap={12}>
      <Row gap={8} wrap>{DIMENSIONS.filter((key) => narrow || !['station', 'channel', 'time'].includes(key)).map(menu)}</Row>
      <Text size="md" color="secondary">Filters combine. Messages are not linked to workers.</Text>
    </Column>}
    {count > 0 && <Row gap={12} align="center" wrap>
      <Text size="md" color="secondary">{activeLine(minute, count, technical)}</Text>
      <Button color="secondary" label="Clear filters" onPress={onReset} />
    </Row>}
  </Column>;
}
