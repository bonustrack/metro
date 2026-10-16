import { type ReactNode } from 'react';
import type { ModelSettings } from '@metro-labs/client/api/model';
import { usageModel } from '@metro-labs/client/api/model-usage';
import { providerInfo, routedConnection, routedUsage } from '@metro-labs/client/api/providers';
import { routeHash } from '@metro-labs/client/route';
import { ProviderLogo } from '../ProviderLogo.js';
import { ErrorState } from '../ui/ErrorState.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { useModelQuery } from '../../lib/model-queries.js';
import { queryError } from '../../lib/queries.js';
import { routeSummary, weekUsage } from '../../lib/settings-values.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useNow } from '../../lib/use-now.js';

const ORGANIZATION = 'Uses the organization’s route';
const OWN = 'Own route';
const NONE = 'No model yet';
const NOT_ENROLLED = 'Not enrolled with the organization, so no model';

function titleOf(settings: ModelSettings): string {
  if (settings.route === null) return NONE;
  return settings.source === 'agent' ? OWN : ORGANIZATION;
}

function problemOf(settings: ModelSettings): string | null {
  if (settings.sync !== null && !settings.sync.enrolled) return NOT_ENROLLED;
  return settings.reason;
}

function RouteItem({ settings, href }: { settings: ModelSettings; href: string }): ReactNode {
  const technical = useTechnicalDetails();
  const now = useNow(60_000);
  const conn = routedConnection(settings);
  const model = settings.route === null ? '' : usageModel(settings, settings.route.primary);
  const problem = problemOf(settings);
  const steps = routeSummary(settings.route, (connection, name) => (name !== '' ? name : usageModel(settings, { connection, model: name }) || (settings.connections.find((c) => c.id === connection)?.label ?? 'a model')));
  const plain = conn === undefined ? undefined : technical ? `${conn.id} · ${steps}` : steps;
  const usage = conn === undefined ? null : weekUsage(routedUsage(settings), conn.provider, model, now);
  const logo = conn === undefined ? undefined : <ProviderLogo provider={providerInfo(conn.provider)} size={ICON_SIZE.lg} />;
  return <Item title={titleOf(settings)} subtitle={problem ?? plain} subtitleTone={problem === null ? 'secondary' : 'danger'} leading={logo} value={usage ?? undefined} href={href} />;
}

export function ModelGroup({ project }: { project: string }): ReactNode {
  const model = useModelQuery();
  const href = routeHash({ kind: 'model', project });
  return (
    <Group label="Model">
      {model.data === undefined ? (
        model.error === null ? <RowsSkeleton rows={1} /> : <ErrorState title="Could not read the model" text={queryError(model.error, 'The agent did not answer.')} onRetry={model.refetch} />
      ) : (
        <RouteItem settings={model.data} href={href} />
      )}
    </Group>
  );
}
