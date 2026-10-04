import { type ReactNode } from 'react';
import { View } from 'react-native';
import { Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { KebabMenu } from './KebabMenu.js';
import { ProviderLogo } from './ProviderLogo.js';
import { UsageBar, UsageShort } from './ModelUsage.js';
import { useModelName } from './AgentModel.js';
import { connectionNote, mostUsed } from './ProviderCard.js';
import { SettingsGroup, SettingsPad, useStacked } from './SettingsSection.js';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
import { Tag } from './Tag.js';
import type { MenuItem } from './Dropdown.js';
import { holdLine, PROVIDERS, type ChainRow, type ConnectionRow, type ModelSettings } from '@metro-labs/client/api/model';
import { routedConnection } from '@metro-labs/client/api/providers';
import { sameRoute, type Slot } from '@metro-labs/client/api/route-edit';
import { whenLabel } from '@metro-labs/client/api/when';
import { useAccountOf } from '../lib/queries.js';

const NOTE = 'Requests go to the first model with room. Past 95% of its usage, or at its limit, the agent moves down the list, and back up once the usage resets.';
const PASSTHROUGH = 'passthrough';
const OLD = 'Update Metro to add fallback models.';
const NONE = 'No fallback yet. Add one so the agent keeps working when its model runs out.';
const MARK = 22;

export interface RouteActions {
  edit: (slot: Slot) => void;
  move: (at: number, by: number) => void;
  promote: (at: number) => void;
  remove: (at: number) => void;
}

interface Item {
  slot: Slot;
  connection: ConnectionRow | undefined;
  model: string;
  row: ChainRow | undefined;
}

function itemsOf(settings: ModelSettings): Item[] {
  const routed = routedConnection(settings);
  const head = settings.chain[0];
  const server: ChainRow = { connection: '', model: '', used: mostUsed(settings, PASSTHROUGH), hold: null, active: true };
  const primary: Item = { slot: { kind: 'primary' }, connection: routed, model: routed?.model !== '' ? (routed?.model ?? '') : (head?.model ?? ''), row: head ?? (routed === undefined ? server : undefined) };
  const rest = (settings.fallbacks ?? []).map((f, at): Item => ({
    slot: { kind: 'fallback', at },
    connection: settings.connections.find((c) => c.id === f.connection),
    model: f.model,
    row: settings.chain.slice(1).find((r) => sameRoute(r, f)),
  }));
  return [primary, ...rest];
}

function Mark({ n, active }: { n: number; active: boolean }): ReactNode {
  const palette = useKitPalette();
  const style = { width: MARK, height: MARK, borderRadius: MARK / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? palette.text : palette.border } as const;
  return (
    <View style={style}>
      <Text size="4xs" weight="semibold" color={active ? palette.bg : palette.link}>{String(n)}</Text>
    </View>
  );
}

function Status({ row, compact }: { row: ChainRow | undefined; compact: boolean }): ReactNode {
  if (row === undefined) return null;
  if (row.hold !== null) return <Text size="2xs" role="danger" numberOfLines={1}>{compact ? 'Skipped' : `Skipped: ${holdLine(row.hold)}`}</Text>;
  return compact ? <UsageShort used={row.used} /> : <UsageBar used={row.used} />;
}

function menuOf(item: Item, last: boolean, compact: boolean, actions: RouteActions): MenuItem[] {
  const edit: MenuItem[] = compact ? [{ label: 'Edit', onSelect: () => { actions.edit(item.slot); } }] : [];
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

function noteOf(item: Item, account: string | null, settings: ModelSettings): string {
  const conn = item.connection;
  const where = conn === undefined ? 'Claude Code login of the server' : [conn.label, connectionNote(conn, account)].filter((x) => x !== '').join(' · ');
  const zdr = conn?.provider === 'openrouter' && conn.zdr ? 'zero data retention' : '';
  const served = item.slot.kind === 'primary' && settings.lastServed !== null ? `last used ${whenLabel(settings.lastServed.at)}` : '';
  return [where, zdr, served].filter((x) => x !== '').join(' · ');
}

function holdNote(item: Item, compact: boolean): string {
  return compact && item.row?.hold != null ? `Skipped: ${holdLine(item.row.hold)}` : '';
}

function RouteRow({ item, n, last, busy, settings, actions }: { item: Item; n: number; last: boolean; busy: boolean; settings: ModelSettings; actions: RouteActions }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const compact = useStacked();
  const name = useModelName(item.connection, item.model);
  const account = useAccountOf(item.connection);
  const menu = menuOf(item, last, compact, actions);
  const icon = (
    <Row align="center" gap={12}>
      <Mark n={n} active={item.row?.active === true} />
      <ProviderLogo provider={PROVIDERS.find((p) => p.id === item.connection?.provider)} size={LIST_ICON_SIZE} />
    </Row>
  );
  const trailing = (
    <>
      <Status row={item.row} compact={compact} />
      {compact ? null : <Button size="md" color="secondary" dark={dark} label="Edit" disabled={busy} onPress={() => { actions.edit(item.slot); }} />}
      {menu.length === 0 ? null : <KebabMenu label={`${name} menu`} items={menu} />}
    </>
  );
  const detail = [noteOf(item, account, settings), holdNote(item, compact)].filter((x) => x !== '').join(' · ');
  return (
    <ListRow
      title={name}
      detail={detail}
      icon={icon}
      extra={item.row?.active === true && n > 1 ? <Tag label="In use now" /> : undefined}
      onPress={busy ? undefined : () => { actions.edit(item.slot); }}
      trailing={trailing}
    />
  );
}

function FallbackInUse({ settings }: { settings: ModelSettings }): ReactNode {
  const at = settings.chain.findIndex((row) => row.active);
  const hold = settings.chain[0]?.hold ?? null;
  if (at <= 0) return null;
  return (
    <SettingsPad>
      <Text size="2xs" role="danger">{`The primary model is skipped${hold === null ? '' : ` (${holdLine(hold)})`}. Requests now go to number ${String(at + 1)} on the list.`}</Text>
    </SettingsPad>
  );
}

export function ModelRouting({ settings, busy, actions }: { settings: ModelSettings; busy: boolean; actions: RouteActions }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const items = itemsOf(settings);
  const canAdd = settings.fallbacks !== null && settings.connections.length > 0;
  const add = <Button size="md" dark={dark} label="Add fallback" disabled={busy || !canAdd} onPress={() => { actions.edit({ kind: 'new' }); }} />;
  return (
    <SettingsGroup title="Model order" note={NOTE} action={add}>
      <FallbackInUse settings={settings} />
      {items.map((item, at) => (
        <RouteRow key={item.slot.kind === 'fallback' ? `${String(item.slot.at)}:${item.model}` : 'primary'} item={item} n={at + 1} last={at === items.length - 1} busy={busy} settings={settings} actions={actions} />
      ))}
      {settings.reason === null ? null : (
        <SettingsPad>
          <Text size="2xs" role="danger">{settings.reason}</Text>
        </SettingsPad>
      )}
      {settings.fallbacks === null ? (
        <SettingsPad>
          <Text size="2xs" role="secondary">{OLD}</Text>
        </SettingsPad>
      ) : settings.fallbacks.length === 0 && settings.connections.length > 0 ? (
        <SettingsPad>
          <Text size="2xs" role="secondary">{NONE}</Text>
        </SettingsPad>
      ) : null}
    </SettingsGroup>
  );
}
