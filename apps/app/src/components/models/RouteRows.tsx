import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { holdLine } from '@metro-labs/client/api/model';
import { modelAccount, type ModelOrderItem } from '@metro-labs/client/api/model-order';
import { limitNote, modelWindows, usageDetail, USAGE_LIMIT } from '@metro-labs/client/api/model-usage';
import { providerInfo } from '@metro-labs/client/api/providers';
import { useModelName } from '../AgentModel.js';
import { Icon } from '../Icon.js';
import { KebabMenu } from '../KebabMenu.js';
import { UsageBar } from '../ModelUsage.js';
import { ProviderLogo } from '../ProviderLogo.js';
import type { MenuItem } from '../Dropdown.js';
import type { RouteActions } from '../route-actions.js';
import { useIsNarrow } from '../../lib/media.js';
import { accountLine as connectionLine } from '../../lib/model-words.js';
import { shownWindow } from '../../lib/settings-values.js';
import { SHRINK } from '../../lib/style.js';
import { useNow } from '../../lib/use-now.js';
import { ICON_SIZE } from '../ui/sizes.js';

const LOGO = 28;
const CHEVRON = 20;
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, minHeight: 60, borderBottomWidth: 1 },
});

interface Usage {
  bar: { used: number; blocked: boolean } | null;
  text: string | null;
}

function useUsage(item: ModelOrderItem): Usage {
  const now = useNow(60_000);
  const provider = item.connection?.provider ?? 'anthropic';
  if (item.usage === undefined) return { bar: null, text: null };
  const credit = item.usage.windows.find((w) => w.label === 'Credits')?.detail;
  if (credit != null) return { bar: null, text: credit };
  const shown = shownWindow(modelWindows(item.usage.windows, provider, item.model, now));
  if (shown?.used == null) return { bar: null, text: usageDetail(item.usage, provider, item.model, now) };
  return { bar: { used: shown.used, blocked: shown.used > USAGE_LIMIT }, text: limitNote(shown) };
}

function accountLine(item: ModelOrderItem): string {
  const parts = [item.connection?.label ?? '', modelAccount(item)].filter((part) => part !== '');
  return [...new Set(parts)].join(' · ');
}

function trouble(item: ModelOrderItem): string | null {
  if (item.connection === undefined) return null;
  const line = connectionLine(item.connection);
  return line.bad ? line.text : null;
}

function Status({ item }: { item: ModelOrderItem }): ReactNode {
  const hold = item.row?.hold ?? null;
  const problem = trouble(item);
  return (
    <Text size="xs" role={item.connection === undefined ? 'danger' : 'secondary'} numberOfLines={2}>
      {accountLine(item)}
      {problem === null ? null : <Text size="xs" role="danger">{` · ${problem}`}</Text>}
      {item.row?.active === true ? <Text size="xs" role="success">{' · In use'}</Text> : null}
      {hold === null ? null : <Text size="xs" role="danger">{` · Skipped: ${holdLine(hold)}`}</Text>}
    </Text>
  );
}

function Lines({ item, name, usage, technical, narrow }: { item: ModelOrderItem; name: string; usage: Usage; technical: boolean; narrow: boolean }): ReactNode {
  return (
    <Col flex={1} minWidth={0} gap={2}>
      <Text size="md" numberOfLines={1}>
        {name}
      </Text>
      <Status item={item} />
      {usage.text === null ? null : (
        <Text size="xs" role="secondary" numberOfLines={2}>
          {usage.text}
        </Text>
      )}
      {narrow && usage.bar !== null ? <UsageBar used={usage.bar.used} blocked={usage.bar.blocked} /> : null}
      {technical && item.connection !== undefined ? (
        <Text size="xs" role="secondary" numberOfLines={1}>
          {`${item.connection.id} · ${item.model === '' ? 'default model' : item.model}`}
        </Text>
      ) : null}
    </Col>
  );
}

interface ModelRowProps {
  item: ModelOrderItem;
  technical: boolean;
  onPress?: () => void;
  menu?: MenuItem[];
}

export function ModelRow({ item, technical, onPress, menu }: ModelRowProps): ReactNode {
  const palette = useKitPalette();
  const narrow = useIsNarrow();
  const name = useModelName(item.connection, item.model);
  const usage = useUsage(item);
  const frame = StyleSheet.flatten([styles.row, { borderBottomColor: palette.border }]);
  const body = (
    <>
      <ProviderLogo provider={providerInfo(item.connection?.provider)} size={LOGO} />
      <Lines item={item} name={name} usage={usage} technical={technical} narrow={narrow} />
      {narrow || usage.bar === null ? null : (
        <View style={SHRINK}>
          <UsageBar used={usage.bar.used} blocked={usage.bar.blocked} />
        </View>
      )}
      {menu === undefined ? null : <KebabMenu ghost label={`${name} menu`} items={menu} />}
      {menu === undefined && onPress !== undefined ? <Icon name="chevronRight" size={CHEVRON} color={palette.sub} /> : null}
    </>
  );
  if (onPress === undefined || menu !== undefined) return <View style={frame}>{body}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={onPress} style={frame}>
      {body}
    </Pressable>
  );
}

export function backupMenu(at: number, last: boolean, actions: RouteActions): MenuItem[] {
  return [
    { label: 'Change', onSelect: () => { actions.edit({ kind: 'fallback', at }); } },
    ...(at === 0 ? [] : [{ label: 'Move up', icon: 'arrowUp' as const, onSelect: () => { actions.move(at, -1); } }]),
    ...(last ? [] : [{ label: 'Move down', icon: 'arrowDown' as const, onSelect: () => { actions.move(at, 1); } }]),
    { label: 'Make it the main model', onSelect: () => { actions.promote(at); } },
    { label: 'Remove', danger: true, onSelect: () => { actions.remove(at); } },
  ];
}

export function AddRow({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }): ReactNode {
  const palette = useKitPalette();
  const frame = StyleSheet.flatten([styles.row, { borderBottomColor: palette.border }]);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={frame}>
      <Icon name="plus" size={ICON_SIZE.md} color={disabled ? palette.sub : palette.link} />
      <Row flex={1}>
        <Text size="md" role={disabled ? 'secondary' : 'default'}>
          {label}
        </Text>
      </Row>
    </Pressable>
  );
}
