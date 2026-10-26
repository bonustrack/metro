import { type ReactNode, useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import type { ActivityCall } from '@metro-labs/client/api/connector-activity';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { routeHash } from '@metro-labs/client/route';
import { AgentAvatar } from '../AgentAvatar.js';
import { ConnectorFavicon } from '../ConnectorFavicon.js';
import { RouteLink } from '../RouteLink.js';
import { AVATAR_SIZE, ICON_SIZE } from '../ui/sizes.js';
import { agoWords, durationWords, outcomeWords } from '../../lib/activity-words.js';
import { toolLabel } from '../../lib/tool-labels.js';
import { MONO, SHRINK } from '../../lib/style.js';

const DOT = 8;
const ENTER_MS = 260;
const ENTER_FROM = -10;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, minHeight: 68, borderBottomWidth: 1 },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  end: { alignItems: 'flex-end', gap: 2, maxWidth: '40%' },
});

interface RowProps {
  call: ActivityCall;
  server?: Server | undefined;
  now: number;
  technical: boolean;
  fresh: boolean;
  showAgent?: boolean;
}

function useEntrance(fresh: boolean): Animated.Value {
  const shown = useRef(new Animated.Value(fresh ? 0 : 1)).current;
  useEffect(() => {
    if (!fresh) return;
    Animated.timing(shown, { toValue: 1, duration: ENTER_MS, useNativeDriver: false }).start();
  }, [fresh, shown]);
  return shown;
}

function Outcome({ outcome }: { outcome: string }): ReactNode {
  const palette = useKitPalette();
  const words = outcomeWords(outcome);
  const dot = words.dot === null ? null : StyleSheet.flatten([styles.dot, { backgroundColor: words.dot === 'danger' ? palette.danger : palette.success }]);
  return (
    <Row align="center" gap={6}>
      {dot === null ? null : <View style={dot} />}
      <Text size="xs" color={words.dot === 'danger' ? 'danger' : undefined} numberOfLines={1}>
        {words.word}
      </Text>
    </Row>
  );
}

const connectorOf = (call: ActivityCall): string => call.connectorName ?? (call.connectorKey === '' ? 'Unknown connector' : call.connectorKey);

function RawName({ call }: { call: ActivityCall }): ReactNode {
  return (
    <Text size="xs" color="secondary" numberOfLines={1} style={MONO}>
      {call.connectorKey === '' ? call.tool : `${call.connectorKey}.${call.tool}`}
    </Text>
  );
}

function What({ call, technical }: { call: ActivityCall; technical: boolean }): ReactNode {
  const connector = connectorOf(call);
  return (
    <Column gap={2} minWidth={0}>
      <Row align="center" gap={6} minWidth={0}>
        <ConnectorFavicon name={connector} url={call.connectorUrl ?? ''} size={ICON_SIZE.sm} />
        <Text size="xs" color="secondary" numberOfLines={1} style={SHRINK}>
          {`${connector} · ${toolLabel(call.tool)}`}
        </Text>
      </Row>
      {technical ? <RawName call={call} /> : null}
    </Column>
  );
}

function AgentLines({ call, server, name, technical }: { call: ActivityCall; server: Server | undefined; name: string; technical: boolean }): ReactNode {
  return (
    <>
      <AgentAvatar seed={server?.host ?? call.agent} src={server?.avatar ?? null} size={AVATAR_SIZE.list} />
      <Column weight={1} minWidth={0} gap={2}>
        <Text size="md" numberOfLines={1}>
          {name}
        </Text>
        <What call={call} technical={technical} />
      </Column>
    </>
  );
}

function ConnectorLines({ call, technical }: { call: ActivityCall; technical: boolean }): ReactNode {
  const connector = connectorOf(call);
  return (
    <>
      <ConnectorFavicon name={connector} url={call.connectorUrl ?? ''} size={ICON_SIZE.lg} />
      <Column weight={1} minWidth={0} gap={2}>
        <Text size="md" numberOfLines={1}>
          {`${connector} · ${toolLabel(call.tool)}`}
        </Text>
        {technical ? <RawName call={call} /> : null}
      </Column>
    </>
  );
}

export function ActivityRow({ call, server, now, technical, fresh, showAgent = true }: RowProps): ReactNode {
  const palette = useKitPalette();
  const shown = useEntrance(fresh);
  const name = server === undefined ? (call.agentName ?? 'Removed agent') : serverLabel(server);
  const frame = StyleSheet.flatten([styles.row, { borderBottomColor: palette.border }]);
  const motion = { opacity: shown, transform: [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [ENTER_FROM, 0] }) }] };
  const when = technical ? new Date(call.at).toLocaleString() : agoWords(call.at, now);
  const body = (
    <>
      {showAgent ? <AgentLines call={call} server={server} name={name} technical={technical} /> : <ConnectorLines call={call} technical={technical} />}
      <View style={styles.end}>
        <Outcome outcome={call.outcome} />
        <Text size="xs" color="secondary" numberOfLines={1}>
          {`${durationWords(call.ms)} · ${when}`}
        </Text>
      </View>
    </>
  );
  return (
    <Animated.View style={motion}>
      {server === undefined || !showAgent ? (
        <View style={frame}>{body}</View>
      ) : (
        <RouteLink to={routeHash({ kind: 'home', project: server.id })} label={`${name}: ${toolLabel(call.tool)}`} style={frame}>
          {body}
        </RouteLink>
      )}
    </Animated.View>
  );
}
