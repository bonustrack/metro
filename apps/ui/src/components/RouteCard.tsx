import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { ProviderLogo } from './ProviderLogo.js';
import { PROVIDERS, type ModelSettings } from '../api/model.js';
import { DEFAULT_MODEL, modelLabel, routedConnection } from '../api/providers.js';
import { tallyLine } from '../api/usage.js';
import { whenLabel } from '../api/when.js';
import { SHRINK } from '../theme.js';

const LOGO = 32;

const NOTHING_YET = 'No request has come through yet. Only a session started with metro claude on this machine does.';

function Since({ settings }: { settings: ModelSettings }): ReactNode {
  const conn = routedConnection(settings);
  const served = settings.lastServed;
  const tally = conn === undefined ? null : (settings.usage[conn.id]?.tally ?? null);
  return (
    <Col gap={2}>
      <Text size="sm" role="secondary">{served === null ? NOTHING_YET : `Last request ${whenLabel(served.at)}`}</Text>
      {tally === null ? null : <Text size="sm" role="secondary">{tallyLine(tally)}</Text>}
    </Col>
  );
}

export function RouteCard({ settings, onChange }: { settings: ModelSettings; onChange: () => void }): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  const side = { width: 1, color: palette.border };
  const conn = routedConnection(settings);
  return (
    <Col gap={14} padding={16} radius={BLOCK_RADIUS_DEFAULT} border={{ top: side, right: side, bottom: side, left: side }}>
      <Row justify="between" align="center" gap={12} wrap>
        <Row gap={12} align="center" style={SHRINK}>
          <ProviderLogo provider={PROVIDERS.find((p) => p.id === conn?.provider)} size={LOGO} />
          <Col gap={2} style={SHRINK}>
            <Text size="lg" weight="semibold" numberOfLines={1}>
              {conn === undefined ? DEFAULT_MODEL : modelLabel(conn)}
            </Text>
            <Text size="sm" role="secondary" numberOfLines={1}>
              {conn?.label ?? 'Your Claude Code login'}
            </Text>
          </Col>
        </Row>
        {settings.connections.length === 0 ? null : <Button size="sm" dark={dark} label="Change model" onPress={onChange} />}
      </Row>
      {settings.reason === null ? null : (
        <Text size="sm" role="danger">
          {settings.reason}
        </Text>
      )}
      <Since settings={settings} />
    </Col>
  );
}
