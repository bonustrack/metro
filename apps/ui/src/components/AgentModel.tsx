import { type ReactNode } from 'react';
import { Text } from './ui.js';
import { ProviderLogo } from './ProviderLogo.js';
import { PROVIDERS, type ConnectionRow, type ModelSettings } from '../api/model.js';
import { DEFAULT_MODEL, routedConnection } from '../api/providers.js';
import { queryError, useConnectionModelsQuery, useModelQuery } from '../api/queries.js';
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

function Card({ settings, href, onOpen }: { settings: ModelSettings; href: string; onOpen: () => void }): ReactNode {
  const conn = routedConnection(settings);
  const name = useModelName(conn);
  const usage = conn === undefined ? undefined : settings.usage[conn.id];
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
        <Text size="md" weight="medium" numberOfLines={1}>
          {name}
        </Text>
        <Text size="sm" role="secondary" numberOfLines={1}>
          {conn?.label ?? 'Your Claude Code login'}
        </Text>
        {settings.reason !== null ? (
          <Text size="sm" role="danger">
            {settings.reason}
          </Text>
        ) : low === undefined ? null : (
          <Text size="sm" role="danger">
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
