import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { AgentAvatar } from './AgentAvatar.js';
import { Tip } from './Tip.js';
import { useServersQuery } from '../lib/queries.js';

const SIZE = 28;
const MAX = 5;
const RING = 2;

const styles = StyleSheet.create({
  cell: { borderRadius: SIZE, borderWidth: RING },
  overlap: { marginLeft: -8 },
  more: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: 'center', justifyContent: 'center' },
});

function Cell({ id, server, first }: { id: string; server: Server | undefined; first: boolean }): ReactNode {
  const palette = useKitPalette();
  return (
    <View style={first ? null : styles.overlap}>
      <Tip label={server === undefined ? id : serverLabel(server)}>
        <View style={[styles.cell, { borderColor: palette.bg }]}>
          <AgentAvatar seed={server?.host ?? id} src={server?.avatar ?? null} size={SIZE} />
        </View>
      </Tip>
    </View>
  );
}

export function AgentStack({ ids }: { ids: string[] }): ReactNode {
  const palette = useKitPalette();
  const { data: servers } = useServersQuery();
  const extra = ids.length - MAX;
  return (
    <Row align="center">
      {ids.slice(0, MAX).map((id, index) => (
        <Cell key={id} id={id} server={servers?.find((s) => s.id === id)} first={index === 0} />
      ))}
      {extra > 0 ? (
        <View style={[styles.cell, styles.overlap, { borderColor: palette.bg }]}>
          <View style={[styles.more, { backgroundColor: palette.inputBg }]}>
            <Text size="md" weight="semibold">{`+${String(extra)}`}</Text>
          </View>
        </View>
      ) : null}
    </Row>
  );
}
