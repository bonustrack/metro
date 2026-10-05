import type { ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { SettingsPad } from './SettingsSection.js';
import { View, type ViewStyle } from 'react-native';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useModeQuery } from '../lib/queries.js';
import { USAGE_SINCE } from '@metro-labs/client/api/usage';
import { olderThan } from '@metro-labs/client/api/version';


function Meter({ used, warn }: { used: number; warn: boolean }): ReactNode {
  const palette = useKitPalette();
  const fill: ViewStyle = { width: `${Math.min(100, Math.round(used * 100))}%`, height: '100%', borderRadius: 3, backgroundColor: warn ? palette.danger : palette.text };
  return (
    <Row width={96} height={6} radius={3} background={palette.border} style={CLIP}>
      <View style={fill} />
    </Row>
  );
}

const CLIP = { overflow: 'hidden' } as const;

export function UsageBar({ used, blocked = false }: { used: number | null; blocked?: boolean }): ReactNode {
  if (used === null) return null;
  const warn = blocked;
  return (
    <Row gap={10} align="center">
      <Meter used={used} warn={warn} />
      <Text size="2xs" role="secondary">
        {`${String(Math.round(used * 100))}%`}
      </Text>
    </Row>
  );
}

export function UsageShort({ used }: { used: number | null }): ReactNode {
  if (used === null) return null;
  return (
    <Text size="2xs" role="secondary">
      {`${String(Math.round(used * 100))}%`}
    </Text>
  );
}

export function UsageUpdateHint({ pad = false }: { pad?: boolean }): ReactNode {
  const mode = useModeQuery();
  if (!olderThan(mode.data?.version ?? null, USAGE_SINCE)) return null;
  const hint = (
    <Text size="2xs" role="secondary">
      Update Metro to see the usage.
    </Text>
  );
  return pad ? <SettingsPad>{hint}</SettingsPad> : hint;
}
