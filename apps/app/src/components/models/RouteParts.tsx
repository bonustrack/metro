import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import type { ConnectionRow } from '@metro-labs/client/api/model';
import type { RouteStep } from '@metro-labs/client/api/model-route';
import type { Slot } from '@metro-labs/client/api/route-edit';
import { providerInfo } from '@metro-labs/client/api/providers';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { AgentAvatar } from '../AgentAvatar.js';
import { Icon } from '../Icon.js';
import { KebabMenu } from '../KebabMenu.js';
import { ProviderLogo } from '../ProviderLogo.js';
import { Item } from '../ui/Item.js';
import { useModelName } from '../AgentModel.js';
import type { MenuItem } from '../Dropdown.js';
import type { RouteActions } from '../ModelRouting.js';
import { accountLine } from '../../lib/model-words.js';

const LOGO = 24;
const STACK = 28;
const OVERLAP = -8;
const SHOWN = 5;

const styles = StyleSheet.create({
  logo: { width: 32, alignItems: 'center' },
  ring: { borderRadius: 999, borderWidth: 2 },
});

function stepLine(connection: ConnectionRow | undefined): string {
  if (connection === undefined) return 'This account was removed';
  const line = accountLine(connection);
  return line.bad ? `${connection.label} · ${line.text}` : connection.label;
}

function backupMenu(at: number, count: number, actions: RouteActions): MenuItem[] {
  return [
    { label: 'Change', onSelect: () => { actions.edit({ kind: 'fallback', at }); } },
    ...(at === 0 ? [] : [{ label: 'Move up', icon: 'arrowUp' as const, onSelect: () => { actions.move(at, -1); } }]),
    ...(at === count - 1 ? [] : [{ label: 'Move down', icon: 'arrowDown' as const, onSelect: () => { actions.move(at, 1); } }]),
    { label: 'Make it the main model', onSelect: () => { actions.promote(at); } },
    { label: 'Remove', danger: true, separated: true, onSelect: () => { actions.remove(at); } },
  ];
}

interface StepRowProps {
  step: RouteStep;
  slot: Slot;
  count: number;
  connections: ConnectionRow[];
  busy: boolean;
  actions?: RouteActions;
}

export function StepRow({ step, slot, count, connections, busy, actions }: StepRowProps): ReactNode {
  const connection = connections.find((c) => c.id === step.connection);
  const name = useModelName(connection, step.model);
  const bad = connection === undefined || connection.signedOut;
  const menu = actions === undefined || slot.kind !== 'fallback' ? undefined : <KebabMenu label={`${name} menu`} items={backupMenu(slot.at, count, actions)} />;
  return (
    <Item title={name} subtitle={stepLine(connection)} subtitleTone={bad ? 'danger' : 'secondary'} trailing={menu} chevron={actions !== undefined && menu === undefined}
      leading={<View style={styles.logo}><ProviderLogo provider={providerInfo(connection?.provider)} size={LOGO} /></View>}
      onPress={actions === undefined || busy || menu !== undefined ? undefined : () => { actions.edit(slot); }} />
  );
}

export function AddRow({ title, disabled, onPress }: { title: string; disabled?: boolean; onPress: () => void }): ReactNode {
  const palette = useKitPalette();
  return <Item title={title} chevron={false} leading={<View style={styles.logo}><Icon name="plus" size={22} color={palette.link} /></View>} onPress={disabled === true ? undefined : onPress} />;
}

export function AvatarStack({ servers }: { servers: Server[] }): ReactNode {
  const palette = useKitPalette();
  const ring = StyleSheet.flatten([styles.ring, { borderColor: palette.bg }]);
  return (
    <Row align="center">
      {servers.slice(0, SHOWN).map((server, at) => (
        <View key={server.id} style={StyleSheet.flatten([ring, { marginLeft: at === 0 ? 0 : OVERLAP }])}>
          <AgentAvatar seed={server.host} src={server.avatar} size={STACK} />
        </View>
      ))}
    </Row>
  );
}

export const serverNames = (servers: Server[]): string[] => servers.map(serverLabel);
