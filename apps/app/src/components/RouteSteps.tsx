import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Icon } from './Icon.js';
import { ProviderLogo } from './ProviderLogo.js';
import { connectionNote } from './ProviderCard.js';
import type { ConnectionRow } from '@metro-labs/client/api/model';
import type { RouteStep } from '@metro-labs/client/api/model-route';
import { providerInfo } from '@metro-labs/client/api/providers';
import { useHover } from './ui/hover.js';

const MARK = 24;
const LOGO = 20;
const OPTION = { paddingVertical: 10, paddingHorizontal: 12, borderWidth: 1, borderRadius: 10 } as const;

function Mark({ n, open, done }: { n: number; open: boolean; done: boolean }): ReactNode {
  const palette = useKitPalette();
  const filled = open || done;
  const style = { width: MARK, height: MARK, borderRadius: MARK / 2, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: filled ? palette.text : palette.border, backgroundColor: filled ? palette.text : 'transparent' } as const;
  return (
    <View style={style}>
      {done && !open ? <Icon name="check" size={14} color={palette.bg} /> : <Text size="md" weight="semibold" color={filled ? palette.bg : palette.sub}>{String(n)}</Text>}
    </View>
  );
}

interface StepProps {
  n: number;
  title: string;
  value: string;
  open: boolean;
  done: boolean;
  last?: boolean;
  locked?: boolean;
  onOpen: () => void;
  children: ReactNode;
}

export function Step({ n, title, value, open, done, last = false, locked = false, onOpen, children }: StepProps): ReactNode {
  const palette = useKitPalette();
  const line = { flex: 1, width: 1, marginTop: 4, backgroundColor: palette.border } as const;
  return (
    <Row gap={12} align="stretch">
      <Col align="center" width={MARK}>
        <Mark n={n} open={open} done={done} />
        {last ? null : <View style={line} />}
      </Col>
      <Col flex={1} minWidth={0} gap={12} padding={{ bottom: last ? 4 : 20 }}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} disabled={open || locked} onPress={onOpen}>
          <Row align="center" gap={8} minHeight={MARK}>
            <Col flex={1} minWidth={0} gap={2}>
              <Text size="xs" weight="medium">{title}</Text>
              {open ? null : <Text size="md" role="secondary" numberOfLines={1}>{value}</Text>}
            </Col>
            {open || locked ? null : <Text size="md" role="link">Change</Text>}
          </Row>
        </Pressable>
        {open ? children : null}
      </Col>
    </Row>
  );
}

function Radio({ on }: { on: boolean }): ReactNode {
  const palette = useKitPalette();
  const ring = { width: 18, height: 18, borderRadius: 9, borderWidth: on ? 5 : 1.5, borderColor: on ? palette.text : palette.sub } as const;
  return <View style={ring} />;
}

function ConnectionOption({ conn, on, onPick }: { conn: ConnectionRow; on: boolean; onPick: (id: string) => void }): ReactNode {
  const palette = useKitPalette();
  const [hovered, hover] = useHover();
  const note = connectionNote(conn);
  const border = { borderColor: on ? palette.text : hovered ? palette.sub : palette.border };
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ checked: on }} {...hover} style={[OPTION, border]} onPress={() => { onPick(conn.id); }}>
      <Row gap={12} align="center">
        <Radio on={on} />
        <ProviderLogo provider={providerInfo(conn.provider)} size={LOGO} />
        <Col flex={1} minWidth={0} gap={2}>
          <Text size="xs" weight="medium" numberOfLines={1}>{conn.label}</Text>
          {note === '' ? null : <Text size="md" role="secondary" numberOfLines={1}>{note}</Text>}
        </Col>
      </Row>
    </Pressable>
  );
}

export function ConnectionStep({ connections, draft, empty, onPick }: { connections: ConnectionRow[]; draft: RouteStep; empty: ReactNode; onPick: (id: string) => void }): ReactNode {
  if (connections.length === 0) return empty;
  return (
    <Col gap={8}>
      {connections.map((c) => (
        <ConnectionOption key={c.id} conn={c} on={c.id === draft.connection} onPick={onPick} />
      ))}
    </Col>
  );
}
