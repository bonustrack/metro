import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { IconCheckmark1 } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconCheckmark1';
import { Row } from '@stage-labs/kit/react-native/box';
import { Glyph } from '@stage-labs/kit/react-native/glyph';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { agentSeed, type Server, serverLabel } from '@metro-labs/client/api/servers';
import { AgentAvatar } from '../AgentAvatar.js';
import { ICON_SIZE } from '../ui/sizes.js';

const STACK = 28;
const OVERLAP = -8;
const SHOWN = 5;

const styles = StyleSheet.create({
  ring: { borderRadius: 999, borderWidth: 2 },
});

export function AvatarStack({ servers }: { servers: Server[] }): ReactNode {
  const palette = useKitPalette();
  const ring = StyleSheet.flatten([styles.ring, { borderColor: palette.bg }]);
  return (
    <Row align="center">
      {servers.slice(0, SHOWN).map((server, at) => (
        <View key={server.id} style={StyleSheet.flatten([ring, { marginLeft: at === 0 ? 0 : OVERLAP }])}>
          <AgentAvatar seed={agentSeed(server)} src={server.avatar} size={STACK} />
        </View>
      ))}
    </Row>
  );
}

export const serverNames = (servers: Server[]): string[] => servers.map(serverLabel);

export function Check(): ReactNode {
  const palette = useKitPalette();
  return <Glyph icon={IconCheckmark1} size={ICON_SIZE.md} color={palette.link} />;
}
