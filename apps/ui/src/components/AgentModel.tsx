import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { UsageBars } from './ModelUsage.js';
import { ProviderLogo } from './ProviderLogo.js';
import { PROVIDERS, type ModelSettings } from '../api/model.js';
import { CONNECTIONS_SINCE, DEFAULT_MODEL, modelLabel, routedConnection } from '../api/providers.js';
import { tallyLine } from '../api/usage.js';
import { queryError, useModelQuery, useModeQuery } from '../api/queries.js';
import { olderThan } from '../api/version.js';
import { whenLabel } from '../api/when.js';
import { routeHash } from '../route.js';
import { opensElsewhere } from './link.js';
import { type Selection } from './selection.js';
import { SHRINK } from '../theme.js';

const LOGO_SIZE = 28;

function Card({ settings, href, onOpen }: { settings: ModelSettings; href: string; onOpen: () => void }): ReactNode {
  const palette = useKitPalette();
  const side = { width: 1, color: palette.border };
  const conn = routedConnection(settings);
  const served = settings.lastServed;
  const usage = conn === undefined ? undefined : settings.usage[conn.id];
  return (
    <Col gap={16} padding={16} radius={BLOCK_RADIUS_DEFAULT} border={{ top: side, right: side, bottom: side, left: side }}>
      <a
        className="block-link"
        href={href}
        onClick={(e) => {
          if (opensElsewhere(e)) return;
          e.preventDefault();
          onOpen();
        }}
      >
        <Row gap={12} align="center">
          <ProviderLogo provider={PROVIDERS.find((p) => p.id === conn?.provider)} size={LOGO_SIZE} />
          <Col gap={2} style={SHRINK}>
            <Text size="md" weight="semibold" numberOfLines={1}>
              {conn === undefined ? DEFAULT_MODEL : modelLabel(conn)}
            </Text>
            <Text size="sm" role="secondary" numberOfLines={1}>
              {`${conn?.label ?? 'Your Claude Code login'}${served === null ? '' : ` · last request ${whenLabel(served.at)}`}`}
            </Text>
          </Col>
        </Row>
      </a>
      {settings.reason === null ? null : (
        <Text size="sm" role="danger">
          {settings.reason}
        </Text>
      )}
      {usage === undefined ? null : (
        <Col gap={10}>
          <UsageBars windows={usage.windows} />
          {usage.tally === null ? null : (
            <Text size="sm" role="secondary">
              {tallyLine(usage.tally)}
            </Text>
          )}
        </Col>
      )}
    </Col>
  );
}

export function AgentRoute({ project, onSelect }: { project: string; onSelect: (s: Selection) => void }): ReactNode {
  const mode = useModeQuery();
  const model = useModelQuery();
  const target: Selection = { kind: 'model', project };
  if (olderThan(mode.data?.version ?? null, CONNECTIONS_SINCE)) return null;
  if (model.error !== null)
    return (
      <Text size="sm" role="danger">
        {queryError(model.error, 'Could not read the model settings.')}
      </Text>
    );
  if (model.data === undefined) return null;
  return (
    <Card
      settings={model.data}
      href={routeHash(target)}
      onOpen={() => {
        onSelect(target);
      }}
    />
  );
}
