import { type ReactNode } from 'react';
import { View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { KebabMenu } from './KebabMenu.js';
import { ProviderLogo } from './ProviderLogo.js';
import { CardUsage, useModelName } from './AgentModel.js';
import { useAccountOf } from '../lib/model-queries.js';
import { modelAccount, type ModelOrderItem } from '@metro-labs/client/api/model-order';
import { SettingsGroup } from './SettingsSection.js';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
import { Tag } from './Tag.js';
import type { MenuItem } from './Dropdown.js';
import { holdLine } from '@metro-labs/client/api/model';
import { providerInfo } from '@metro-labs/client/api/providers';
import type { Slot } from '@metro-labs/client/api/route-edit';

const MARK = 24;

export interface RouteActions {
  edit: (slot: Slot) => void;
  move: (at: number, by: number) => void;
  promote: (at: number) => void;
  remove: (at: number) => void;
}

function Mark({ n, active }: { n: number; active: boolean }): ReactNode {
  const palette = useKitPalette();
  const style = { width: MARK, height: MARK, borderRadius: MARK / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? palette.text : palette.border } as const;
  return (
    <View style={style}>
      <Text size="md" weight="semibold" color={active ? palette.bg : palette.link}>{String(n)}</Text>
    </View>
  );
}

function menuOf(item: ModelOrderItem, last: boolean, actions: RouteActions): MenuItem[] {
  const edit: MenuItem[] = [{ label: 'Edit', onSelect: () => { actions.edit(item.slot); } }];
  if (item.slot.kind !== 'fallback') return edit;
  const { at } = item.slot;
  return [
    ...edit,
    ...(at === 0 ? [] : [{ label: 'Move up', icon: 'arrowUp' as const, onSelect: () => { actions.move(at, -1); } }]),
    ...(last ? [] : [{ label: 'Move down', icon: 'arrowDown' as const, onSelect: () => { actions.move(at, 1); } }]),
    { label: 'Make primary', onSelect: () => { actions.promote(at); } },
    { label: 'Remove', danger: true, separated: true, onSelect: () => { actions.remove(at); } },
  ];
}

function noteOf(item: ModelOrderItem): string {
  const where = item.connection?.label ?? 'Connection removed';
  const hold = item.row?.hold;
  const reason = hold == null ? '' : holdLine(hold);
  const clarified = item.connection?.provider === 'anthropic' ? reason.replace(/^Weekly (\d)/, 'Weekly, all models $1') : reason;
  return [where, hold == null ? '' : `Skipped: ${clarified}`].filter((part) => part !== '').join(' · ');
}

interface RowProps {
  item: ModelOrderItem;
  n: number;
  last: boolean;
  busy: boolean;
  withUsage: boolean;
  actions?: RouteActions;
}

const mutedRow = (item: ModelOrderItem): boolean => item.row?.hold != null || item.connection === undefined || item.connection.signedOut;

function RowIcon({ item, n }: { item: ModelOrderItem; n: number }): ReactNode {
  return (
    <Row align="center" gap={12}>
      <Mark n={n} active={item.row?.active === true} />
      <ProviderLogo provider={providerInfo(item.connection?.provider)} size={LIST_ICON_SIZE} />
    </Row>
  );
}

function RowBelow({ item, withUsage }: { item: ModelOrderItem; withUsage: boolean }): ReactNode {
  const account = modelAccount(item, useAccountOf(item.connection));
  return (
    <Col gap={4}>
      <Text size="md" role="secondary" numberOfLines={1}>{account}</Text>
      {withUsage ? <CardUsage usage={item.usage} provider={item.connection?.provider ?? 'anthropic'} model={item.model} /> : null}
    </Col>
  );
}

function RouteRow({ item, n, last, busy, withUsage, actions }: RowProps): ReactNode {
  const name = useModelName(item.connection, item.model);
  const edit = busy || actions === undefined ? undefined : (): void => { actions.edit(item.slot); };
  return (
    <ListRow
      title={name}
      detail={noteOf(item)}
      below={<RowBelow item={item} withUsage={withUsage} />}
      muted={mutedRow(item)}
      icon={<RowIcon item={item} n={n} />}
      extra={item.row?.active === true ? <Tag label="In use" /> : undefined}
      onPress={edit}
      trailing={actions === undefined ? undefined : <KebabMenu label={`${name} menu`} items={menuOf(item, last, actions)} />}
    />
  );
}

interface ModelRoutingProps {
  title: string;
  note: string;
  items: ModelOrderItem[];
  busy: boolean;
  canAdd: boolean;
  withUsage: boolean;
  actions?: RouteActions;
  children?: ReactNode;
}

export function ModelRouting({ title, note, items, busy, canAdd, withUsage, actions, children }: ModelRoutingProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const add = actions === undefined ? undefined : <Button size="md" dark={dark} label="Add fallback" disabled={busy || !canAdd} onPress={() => { actions.edit({ kind: 'new' }); }} />;
  return (
    <SettingsGroup title={title} note={note} action={add}>
      {items.map((item, at) => (
        <RouteRow key={item.slot.kind === 'fallback' ? `${String(item.slot.at)}:${item.model}` : 'primary'} item={item} n={at + 1} last={at === items.length - 1} busy={busy} withUsage={withUsage} actions={actions} />
      ))}
      {children}
    </SettingsGroup>
  );
}
