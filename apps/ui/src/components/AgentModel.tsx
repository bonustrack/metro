import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from './ui.js';
import { FieldLabel } from './FieldLabel.js';
import { ModelUsage } from './ModelUsage.js';
import { ProviderLogo } from './ProviderLogo.js';
import { PROVIDERS, routeLabel, servedLabel, type ModelSettings } from '../api/model.js';
import { USAGE_PROVIDERS, type UsageProvider } from '../api/usage.js';
import { queryError, useModelQuery } from '../api/queries.js';
import { whenLabel } from '../api/when.js';
import { routeHash } from '../route.js';
import { opensElsewhere } from './link.js';
import { type Selection } from './selection.js';

const LOGO_SIZE = 20;

function Route({ settings, href, onOpen }: { settings: ModelSettings; href: string; onOpen: () => void }): ReactNode {
  const served = settings.lastServed;
  return (
    <Col gap={2}>
      <FieldLabel>Model</FieldLabel>
      <a
        className="pill-link"
        href={href}
        onClick={(e) => {
          if (opensElsewhere(e)) return;
          e.preventDefault();
          onOpen();
        }}
      >
        <Row gap={8} align="center">
          <ProviderLogo provider={PROVIDERS.find((p) => p.id === settings.provider)} size={LOGO_SIZE} />
          <Text size="sm">{routeLabel(settings)}</Text>
        </Row>
      </a>
      {settings.reason === null ? null : (
        <Text size="sm" role="danger">
          {settings.reason}
        </Text>
      )}
      <Text size="sm" role="secondary">
        {served === null ? 'No request served yet.' : `Last request: ${servedLabel(served)}, ${whenLabel(served.at)}`}
      </Text>
    </Col>
  );
}

const usageProvider = (name: string): UsageProvider | undefined => USAGE_PROVIDERS.find((p) => p === name);

function currentProvider(settings: ModelSettings): UsageProvider | undefined {
  return usageProvider(settings.lastServed?.provider ?? settings.provider) ?? usageProvider(settings.provider);
}

export function AgentRoute({ project, onSelect }: { project: string; onSelect: (s: Selection) => void }): ReactNode {
  const model = useModelQuery();
  const target: Selection = { kind: 'model', project };
  if (model.error !== null)
    return (
      <Text size="sm" role="danger">
        {queryError(model.error, 'Could not read the model settings.')}
      </Text>
    );
  if (model.data === undefined) return null;
  return (
    <Route
      settings={model.data}
      href={routeHash(target)}
      onOpen={() => {
        onSelect(target);
      }}
    />
  );
}

export function AgentUsage(): ReactNode {
  const model = useModelQuery();
  if (model.data === undefined) return null;
  return <ModelUsage usage={model.data.usage} only={currentProvider(model.data)} />;
}
