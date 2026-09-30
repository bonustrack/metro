import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { ProviderLogo } from './ProviderLogo.js';
import { UsageLine, UsageUpdateHint } from './ModelUsage.js';
import { PROVIDERS, type ConnectionRow, type ModelSettings } from '../api/model.js';
import { DEFAULT_MODEL, routedConnection, routedUsage } from '../api/providers.js';
import { queryError, useAccountOf, useConnectionModelsQuery, useModelQuery } from '../api/queries.js';
import { tallyLine } from '../api/usage.js';
import { routeHash } from '../route.js';
import { opensElsewhere } from './link.js';
import { type Selection } from './selection.js';

const LOGO_SIZE = 28;

const LOW = 0.9;

export function useModelName(conn: ConnectionRow | undefined): string {
  const models = useConnectionModelsQuery(conn);
  if (conn === undefined || conn.model === '') return DEFAULT_MODEL;
  const found = models.data?.find((option) => option.id === conn.model);
  if (found === undefined || found.name === '') return conn.model;
  const cut = found.name.indexOf(': ');
  return cut === -1 ? found.name : found.name.slice(cut + 2);
}

function CardUsage({ usage }: { usage: ModelSettings['usage'][string] | undefined }): ReactNode {
  if (usage === undefined) return <UsageUpdateHint />;
  if (usage.windows.length === 0)
    return usage.tally === null ? null : (
      <Text size="md" role="secondary">
        {tallyLine(usage.tally)}
      </Text>
    );
  return (
    <span className="model-card-usage">
      {usage.windows.map((window) => (
        <UsageLine key={window.label} window={window} />
      ))}
    </span>
  );
}

function Card({ settings, href, onOpen }: { settings: ModelSettings; href: string; onOpen: () => void }): ReactNode {
  const conn = routedConnection(settings);
  const name = useModelName(conn);
  const account = useAccountOf(conn);
  const usage = routedUsage(settings);
  const low = usage?.windows.find((window) => window.used !== null && window.used >= LOW);
  return (
    <a
      className="model-card"
      href={href}
      onClick={(e) => {
        if (opensElsewhere(e)) return;
        e.preventDefault();
        onOpen();
      }}
    >
      <ProviderLogo provider={PROVIDERS.find((p) => p.id === conn?.provider)} size={LOGO_SIZE} />
      <span className="model-card-text">
        <Text size="lg" weight="medium" numberOfLines={1}>
          {name}
        </Text>
        <Text size="md" role="secondary">
          {[conn?.label ?? 'Your Claude Code login', account].filter((part): part is string => part !== null).join(' · ')}
        </Text>
        <CardUsage usage={usage} />
        {settings.reason !== null ? (
          <Text size="md" role="danger">
            {settings.reason}
          </Text>
        ) : low === undefined ? null : (
          <Text size="md" role="danger">
            {`${low.label} almost used up (${String(Math.round((low.used ?? 0) * 100))}%). Top up or switch model.`}
          </Text>
        )}
      </span>
      <span className="model-card-action">Change</span>
    </a>
  );
}

export function AgentRoute({ project, onSelect }: { project: string; onSelect: (s: Selection) => void }): ReactNode {
  const model = useModelQuery();
  const target: Selection = { kind: 'model', project };
  if (model.error !== null)
    return (
      <Text size="md" role="danger">
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
