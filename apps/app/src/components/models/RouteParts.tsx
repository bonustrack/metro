import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { AgentAvatar } from '../AgentAvatar.js';

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
          <AgentAvatar seed={server.host} src={server.avatar} size={STACK} />
        </View>
      ))}
    </Row>
  );
}

export const serverNames = (servers: Server[]): string[] => servers.map(serverLabel);
