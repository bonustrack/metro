import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { RouteLink } from './RouteLink.js';
import { ProviderLogo } from './ProviderLogo.js';
import { ModelReadError, UsageBar, UsageUnavailable } from './ModelUsage.js';
import { limitingWindow, limitNote, modelWindows, usageDetail, usageModel, usageReported, USAGE_LIMIT } from '@metro-labs/client/api/model-usage';
import { PROVIDERS, type ConnectionRow, type ModelOption, type ModelSettings, type Provider } from '@metro-labs/client/api/model';
import { DEFAULT_MODEL, routedConnection, routedUsage } from '@metro-labs/client/api/providers';
import { useAccountOf, useConnectionModelsQuery, useModelQuery } from '../lib/queries.js';
import { routeHash } from '@metro-labs/client/route';
import { type Selection } from '@metro-labs/client/selection';

const LOGO_SIZE = 28;


export function nameIn(options: ModelOption[] | undefined, model: string): string {
  if (model === '') return DEFAULT_MODEL;
  const found = options?.find((option) => option.id === model);
  if (found === undefined || found.name === '') return model;
  const cut = found.name.indexOf(': ');
  return cut === -1 ? found.name : found.name.slice(cut + 2);
}

export function useModelName(conn: ConnectionRow | undefined, model = conn?.model ?? ''): string {
  const models = useConnectionModelsQuery(conn);
  return conn === undefined ? DEFAULT_MODEL : nameIn(models.data, model);
}

export function CardUsage({ usage, provider, model }: { usage: ModelSettings['usage'][string] | undefined; provider: Provider; model: string }): ReactNode {
  if (usage === undefined) return <UsageUnavailable provider={provider} />;
  const window = limitingWindow(modelWindows(usage.windows, provider, model));
  const blocked = (window?.used ?? 0) > USAGE_LIMIT;
  const reported = usageReported(usage);
  return (
    <Col gap={4} margin={{ top: 4 }}>
      {window === null ? (
        <Text size="2xs" role="secondary">{usageDetail(usage, provider, model)}</Text>
      ) : (
        <Row gap={10} align="center" wrap>
          <UsageBar used={window.used} blocked={blocked} />
          <Text size="2xs" role="secondary">{limitNote(window)}</Text>
          {blocked ? <Text size="2xs" role="secondary">Over the 95% switch limit</Text> : null}
        </Row>
      )}
      {reported === null ? null : <Text size="2xs" role="secondary">{reported}</Text>}
    </Col>
  );
}

const CARD = { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 16, borderWidth: 1, borderRadius: 8 } as const;

function Card({ settings, href }: { settings: ModelSettings; href: string }): ReactNode {
  const palette = useKitPalette();
  const conn = routedConnection(settings);
  const model = usageModel(settings, conn);
  const name = useModelName(conn, model);
  const account = useAccountOf(conn);
  const usage = routedUsage(settings);
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
        <CardUsage usage={usage} provider={conn?.provider ?? 'anthropic'} model={model} />
        {settings.reason !== null ? (
          <Text size="2xs" role="danger">
            {settings.reason}
          </Text>
        ) : null}
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
  return (
    <Col gap={8}>
      <ModelReadError error={model.error} cached={model.data !== undefined} />
      {model.data === undefined ? null : <Card settings={model.data} href={routeHash(target)} />}
    </Col>
  );
}
