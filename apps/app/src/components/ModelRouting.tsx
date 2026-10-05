import { type ReactNode } from 'react';
import { View } from 'react-native';
import { Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { KebabMenu } from './KebabMenu.js';
import { ProviderLogo } from './ProviderLogo.js';
import { useModelName } from './AgentModel.js';
import { mostUsed } from './ProviderCard.js';
import { SettingsGroup, SettingsPad } from './SettingsSection.js';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
import { Tag } from './Tag.js';
import type { MenuItem } from './Dropdown.js';
import { holdLine, PROVIDERS, type ChainRow, type ConnectionRow, type ModelSettings } from '@metro-labs/client/api/model';
import { routedConnection } from '@metro-labs/client/api/providers';
import { sameRoute, type Slot } from '@metro-labs/client/api/route-edit';

const NOTE = 'Uses the first available model. Switches above 95% usage and returns when the limit resets. Tap a model to edit.';
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

function menuOf(item: Item, last: boolean, actions: RouteActions): MenuItem[] {
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

function noteOf(item: Item): string {
  const where = item.connection?.label ?? 'Claude Code login of the server';
  const hold = item.row?.hold;
  const reason = hold == null ? '' : holdLine(hold);
  const clarified = item.connection?.provider === 'anthropic' ? reason.replace(/^Weekly (\d)/, 'Weekly, all models $1') : reason;
  return [where, hold == null ? '' : `Skipped: ${clarified}`].filter((part) => part !== '').join(' · ');
}

function RouteRow({ item, n, last, busy, actions }: { item: Item; n: number; last: boolean; busy: boolean; actions: RouteActions }): ReactNode {
  const name = useModelName(item.connection, item.model);
  const menu = menuOf(item, last, actions);
  const icon = (
    <Row align="center" gap={12}>
      <Mark n={n} active={item.row?.active === true} />
      <ProviderLogo provider={PROVIDERS.find((p) => p.id === item.connection?.provider)} size={LIST_ICON_SIZE} />
    </Row>
  );
  return (
    <ListRow
      title={name}
      detail={noteOf(item)}
      muted={item.row?.hold != null}
      icon={icon}
      extra={item.row?.active === true ? <Tag label="In use" /> : undefined}
      onPress={busy ? undefined : () => { actions.edit(item.slot); }}
      trailing={<KebabMenu label={`${name} menu`} items={menu} />}
    />
  );
}

export function ModelRouting({ settings, busy, actions }: { settings: ModelSettings; busy: boolean; actions: RouteActions }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const items = itemsOf(settings);
  const canAdd = settings.fallbacks !== null && settings.connections.length > 0;
  const add = <Button size="md" dark={dark} label="Add fallback" disabled={busy || !canAdd} onPress={() => { actions.edit({ kind: 'new' }); }} />;
  return (
    <SettingsGroup title="Model order" note={NOTE} action={add}>
      {items.map((item, at) => (
        <RouteRow key={item.slot.kind === 'fallback' ? `${String(item.slot.at)}:${item.model}` : 'primary'} item={item} n={at + 1} last={at === items.length - 1} busy={busy} actions={actions} />
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
