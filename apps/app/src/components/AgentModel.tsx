import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { RouteLink } from './RouteLink.js';
import { ProviderLogo } from './ProviderLogo.js';
import { UsageLine, UsageUpdateHint } from './ModelUsage.js';
import { PROVIDERS, type ConnectionRow, type ModelSettings } from '@metro-labs/client/api/model';
import { DEFAULT_MODEL, routedConnection, routedUsage } from '@metro-labs/client/api/providers';
import { queryError, useAccountOf, useConnectionModelsQuery, useModelQuery } from '../lib/queries.js';
import { tallyLine } from '@metro-labs/client/api/usage';
import { routeHash } from '@metro-labs/client/route';
import { type Selection } from '@metro-labs/client/selection';

const LOGO_SIZE = 28;

const LOW = 0.9;

export function useModelName(conn: ConnectionRow | undefined, model = conn?.model ?? ''): string {
  const models = useConnectionModelsQuery(conn);
  if (conn === undefined || model === '') return DEFAULT_MODEL;
  const found = models.data?.find((option) => option.id === model);
  if (found === undefined || found.name === '') return model;
  const cut = found.name.indexOf(': ');
  return cut === -1 ? found.name : found.name.slice(cut + 2);
}

function CardUsage({ usage }: { usage: ModelSettings['usage'][string] | undefined }): ReactNode {
  if (usage === undefined) return <UsageUpdateHint />;
  if (usage.windows.length === 0)
    return usage.tally === null ? null : (
      <Text size="2xs" role="secondary">
        {tallyLine(usage.tally)}
      </Text>
    );
  return (
    <Row wrap gap={4} style={USAGE_GAP} margin={{ top: 4 }}>
      {usage.windows.map((window) => (
        <UsageLine key={window.label} window={window} />
      ))}
    </Row>
  );
}

const USAGE_GAP = { columnGap: 24, rowGap: 4 } as const;
const CARD = { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 16, borderWidth: 1, borderRadius: 8 } as const;

function Card({ settings, href }: { settings: ModelSettings; href: string }): ReactNode {
  const palette = useKitPalette();
  const conn = routedConnection(settings);
  const name = useModelName(conn);
  const account = useAccountOf(conn);
  const usage = routedUsage(settings);
  const low = usage?.windows.find((window) => window.used !== null && window.used >= LOW);
  const frame = [CARD, { borderColor: palette.border }];
  const hover = { borderColor: palette.sub };
  return (
    <RouteLink to={href} label="Model" style={frame} hoverStyle={hover}>
      <ProviderLogo provider={PROVIDERS.find((p) => p.id === conn?.provider)} size={LOGO_SIZE} />
      <Col gap={2} flex={1} minWidth={0}>
        <Text size="md" weight="semibold" numberOfLines={1}>
          {name}
        </Text>
        <Text size="2xs" role="secondary">
          {[conn?.label ?? 'Your Claude Code login', account].filter((part): part is string => part !== null).join(' · ')}
        </Text>
        <CardUsage usage={usage} />
        {settings.reason !== null ? (
          <Text size="2xs" role="danger">
            {settings.reason}
          </Text>
        ) : low === undefined ? null : (
          <Text size="2xs" role="danger">
            {`${low.label} almost used up (${String(Math.round((low.used ?? 0) * 100))}%). Top up or switch model.`}
          </Text>
        )}
      </Col>
      <Text size="2xs" role="link">
        Change
      </Text>
    </RouteLink>
  );
}

export function AgentRoute({ project }: { project: string }): ReactNode {
  const model = useModelQuery();
  const target: Selection = { kind: 'model', project };
  if (model.error !== null)
    return (
      <Text size="2xs" role="danger">
        {queryError(model.error, 'Could not read the model settings.')}
      </Text>
    );
  if (model.data === undefined) return null;
  return <Card settings={model.data} href={routeHash(target)} />;
}
