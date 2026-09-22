import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { KebabMenu } from './KebabMenu.js';
import { ProviderLogo } from './ProviderLogo.js';
import type { MenuItem } from './Dropdown.js';
import { PROVIDERS, type ConnectionRow, type ModelSettings } from '../api/model.js';
import { connectionDetail, modelLabel } from '../api/providers.js';
import { windowLine } from '../api/usage.js';
import { SHRINK } from '../theme.js';

const LOGO = 20;

const usageLine = (settings: ModelSettings, id: string): string | null => {
  const window = settings.usage[id]?.windows[0];
  return window === undefined ? null : `${window.label} · ${windowLine(window)}`;
};

export function ProviderCard({ connection, settings, items, onUse }: { connection: ConnectionRow; settings: ModelSettings; items: MenuItem[]; onUse: () => void }): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  const inUse = settings.route === connection.id;
  const side = { width: 1, color: inUse ? palette.text : palette.border };
  const usage = usageLine(settings, connection.id);
  return (
    <Col gap={10} padding={14} radius={BLOCK_RADIUS_DEFAULT} border={{ top: side, right: side, bottom: side, left: side }} minWidth={200} maxWidth={280} flex={1}>
      <Row justify="between" align="center" gap={8}>
        <Row gap={8} align="center" style={SHRINK}>
          <ProviderLogo provider={PROVIDERS.find((p) => p.id === connection.provider)} size={LOGO} />
          <Text size="sm" weight="semibold" numberOfLines={1}>
            {connection.label}
          </Text>
        </Row>
        <KebabMenu label={`${connection.label} menu`} items={items} />
      </Row>
      <Col gap={2}>
        <Text size="sm" role={inUse ? undefined : 'secondary'} numberOfLines={1}>
          {modelLabel(connection)}
        </Text>
        <Text size="sm" role="secondary" numberOfLines={1}>
          {usage ?? connectionDetail(connection)}
        </Text>
      </Col>
      {inUse ? (
        <Text size="sm" role="secondary">
          In use
        </Text>
      ) : (
        <Button size="sm" color="secondary" dark={dark} label="Use" onPress={onUse} />
      )}
    </Col>
  );
}
