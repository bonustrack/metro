import { type ReactNode, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Icon } from './Icon.js';
import { ProviderLogo } from './ProviderLogo.js';
import { ProviderSetup } from './ProviderModal.js';
import { UsageBar, UsageShort } from './ModelUsage.js';
import { useStacked } from './SettingsSection.js';
import { connectionNote, mostUsed } from './ProviderCard.js';
import { PROVIDERS, type ConnectionRow, type ModelSettings } from '@metro-labs/client/api/model';
import type { RouteDraft } from '@metro-labs/client/api/route-edit';
import { useAccountOf } from '../lib/queries.js';
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
      {done && !open ? <Icon name="check" size={14} color={palette.bg} /> : <Text size="4xs" weight="semibold" color={filled ? palette.bg : palette.sub}>{String(n)}</Text>}
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
              {open ? null : <Text size="2xs" role="secondary" numberOfLines={1}>{value}</Text>}
            </Col>
            {open || locked ? null : <Text size="2xs" role="link">Change</Text>}
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

function ConnectionOption({ conn, settings, on, onPick }: { conn: ConnectionRow; settings: ModelSettings; on: boolean; onPick: (id: string) => void }): ReactNode {
  const palette = useKitPalette();
  const compact = useStacked();
  const [hovered, hover] = useHover();
  const note = connectionNote(conn, useAccountOf(conn));
  const border = { borderColor: on ? palette.text : hovered ? palette.sub : palette.border };
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ checked: on }} {...hover} style={[OPTION, border]} onPress={() => { onPick(conn.id); }}>
      <Row gap={12} align="center">
        <Radio on={on} />
        <ProviderLogo provider={PROVIDERS.find((p) => p.id === conn.provider)} size={LOGO} />
        <Col flex={1} minWidth={0} gap={2}>
          <Text size="xs" weight="medium" numberOfLines={1}>{conn.label}</Text>
          {note === '' ? null : <Text size="2xs" role="secondary" numberOfLines={1}>{note}</Text>}
        </Col>
        {compact ? <UsageShort used={mostUsed(settings, conn.id)} /> : <UsageBar used={mostUsed(settings, conn.id)} />}
      </Row>
    </Pressable>
  );
}

function AddRow({ onPress }: { onPress: () => void }): ReactNode {
  const palette = useKitPalette();
  const [hovered, hover] = useHover();
  return (
    <Pressable accessibilityRole="button" {...hover} style={[OPTION, { borderStyle: 'dashed', borderColor: hovered ? palette.sub : palette.border }]} onPress={onPress}>
      <Row gap={12} align="center">
        <Icon name="plus" size={18} color={palette.link} />
        <Text size="xs" weight="medium" role="link">Add a connection</Text>
      </Row>
    </Pressable>
  );
}

export function ConnectionStep({ settings, draft, onPick }: { settings: ModelSettings; draft: RouteDraft; onPick: (id: string, saved?: RouteDraft) => void }): ReactNode {
  const none = settings.connections.length === 0;
  const [adding, setAdding] = useState(none);
  if (adding)
    return (
      <ProviderSetup
        onDone={(saved) => { setAdding(false); onPick(saved.connection, saved); }}
        onBack={none ? undefined : () => { setAdding(false); }}
      />
    );
  return (
    <Col gap={8}>
      {settings.connections.map((c) => (
        <ConnectionOption key={c.id} conn={c} settings={settings} on={c.id === draft.connection} onPick={onPick} />
      ))}
      <AddRow onPress={() => { setAdding(true); }} />
    </Col>
  );
}
