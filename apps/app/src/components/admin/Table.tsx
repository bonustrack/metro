import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { TextField } from '@stage-labs/kit/react-native/text-field';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Dropdown } from '../Dropdown.js';
import { Icon } from '../Icon.js';
import { RouteLink } from '../RouteLink.js';
import { side } from '../ui/edges.js';
import { ICON_SIZE, ROUND_BUTTON_SIZE } from '../ui/sizes.js';
import type { SortState } from '../../lib/admin-table.js';
import { hoverColor } from '../../lib/theme.js';
import { SHRINK } from '../../lib/style.js';

const ROW_PAD = 12;
const BAR_WIDTH = 64;
const BAR_HEIGHT = 4;
const WARN = 0.9;
const SEARCH_WIDTH = 440;
const FILTER_WIDTH = 260;

const styles = StyleSheet.create({
  table: { marginHorizontal: -ROW_PAD },
  link: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 10, paddingLeft: ROW_PAD, borderRadius: 10, minHeight: 64 },
  plain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 10, paddingLeft: ROW_PAD, minHeight: 64 },
  menu: { width: ROUND_BUTTON_SIZE + ROW_PAD, alignItems: 'flex-end', paddingRight: 4 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  search: { flexGrow: 1, flexBasis: 240, maxWidth: SEARCH_WIDTH },
  filter: { maxWidth: FILTER_WIDTH },
  clip: { overflow: 'hidden' },
});

export function Table({ children }: { children: ReactNode }): ReactNode {
  return <View style={styles.table}>{children}</View>;
}

export function Cell({ flex, children }: { flex: number; children: ReactNode }): ReactNode {
  return (
    <Column weight={flex} minWidth={0}>
      {children}
    </Column>
  );
}

interface HeadProps<K extends string> {
  label: string;
  column: K;
  sort: SortState<K>;
  flex: number;
  onSort: (column: K) => void;
}

export function HeadCell<K extends string>({ label, column, sort, flex, onSort }: HeadProps<K>): ReactNode {
  const palette = useKitPalette();
  const active = sort.key === column;
  return (
    <Column weight={flex} minWidth={0}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Sort by ${label}`} onPress={() => { onSort(column); }} style={styles.head}>
        <Text size="xs" color={active ? undefined : 'secondary'} fontWeight={active ? 'semibold' : 'normal'} numberOfLines={1} style={SHRINK}>
          {label}
        </Text>
        {active ? <Icon name={sort.dir === 'asc' ? 'arrowUp' : 'arrowDown'} size={ICON_SIZE.sm} color={palette.link} /> : null}
      </Pressable>
    </Column>
  );
}

export function HeadRow({ children }: { children: ReactNode }): ReactNode {
  const palette = useKitPalette();
  return (
    <Row align="center" gap={16} padding={{ left: ROW_PAD, right: ROUND_BUTTON_SIZE + ROW_PAD, bottom: 10 }} border={{ bottom: side(palette.border) }}>
      {children}
    </Row>
  );
}

interface TableRowProps {
  href: string | null;
  label: string;
  menu?: ReactNode;
  children: ReactNode;
}

export function TableRow({ href, label, menu, children }: TableRowProps): ReactNode {
  const palette = useKitPalette();
  const hover = { backgroundColor: hoverColor(palette) };
  return (
    <Row align="center" border={{ bottom: side(palette.border) }}>
      {href === null ? (
        <View style={styles.plain}>{children}</View>
      ) : (
        <RouteLink to={href} label={label} style={styles.link} hoverStyle={hover}>
          {children}
        </RouteLink>
      )}
      <View style={styles.menu}>{menu}</View>
    </Row>
  );
}

export function TwoLines({ top, bottom, topTone }: { top: ReactNode; bottom?: string | null; topTone?: 'danger' | 'secondary' }): ReactNode {
  return (
    <Column gap={2} minWidth={0}>
      {typeof top === 'string' ? (
        <Text size="xs" color={topTone} numberOfLines={1} style={SHRINK}>
          {top}
        </Text>
      ) : (
        top
      )}
      {bottom === undefined || bottom === null ? null : (
        <Text size="2xs" color="secondary" numberOfLines={1}>
          {bottom}
        </Text>
      )}
    </Column>
  );
}

export function ThinBar({ used }: { used: number }): ReactNode {
  const palette = useKitPalette();
  const fill: ViewStyle = { width: `${Math.min(100, Math.max(0, Math.round(used * 100)))}%`, height: '100%', backgroundColor: used >= WARN ? palette.danger : palette.text };
  return (
    <Row align="center" gap={8}>
      <Row width={BAR_WIDTH} height={BAR_HEIGHT} radius={BAR_HEIGHT / 2} background={palette.border} style={styles.clip}>
        <View style={fill} />
      </Row>
      <Text size="2xs" color="secondary">
        {`${String(Math.round(used * 100))}%`}
      </Text>
    </Row>
  );
}

export function SearchBox({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (value: string) => void }): ReactNode {
  return (
    <Column style={styles.search}>
      <TextField value={value} placeholder={placeholder} onChangeText={onChange} inputProps={{ accessibilityLabel: placeholder, autoCapitalize: 'none', autoCorrect: false }} />
    </Column>
  );
}

export interface FilterOption<V> {
  label: string;
  value: V;
}

interface FilterProps<V> {
  name: string;
  value: V;
  options: FilterOption<V>[];
  same: (a: V, b: V) => boolean;
  onChange: (value: V) => void;
}

export function FilterMenu<V>({ name, value, options, same, onChange }: FilterProps<V>): ReactNode {
  const current = options.find((option) => same(option.value, value))?.label ?? 'All';
  return (
    <Dropdown
      label={`Filter by ${name.toLowerCase()}`}
      align="start"
      button={{ label: `${name}: ${current}`, color: 'secondary', size: 'md', style: styles.filter, textStyle: SHRINK }}
      items={options.map((option) => ({ label: option.label, selected: same(option.value, value), onSelect: () => { onChange(option.value); } }))}
    />
  );
}

export function Controls({ children }: { children: ReactNode }): ReactNode {
  return (
    <Row gap={10} wrap align="center">
      {children}
    </Row>
  );
}

export function NoMatch({ text }: { text: string }): ReactNode {
  return (
    <Column padding={{ x: ROW_PAD, y: 20 }}>
      <Text size="xs" color="secondary">
        {text}
      </Text>
    </Column>
  );
}
