import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { currentServer } from '@metro-labs/client/auth/daemon';
import type { ModelSettings, ModelSync } from '@metro-labs/client/api/model';
import type { ModelRoute } from '@metro-labs/client/api/model-route';
import { modelOrder } from '@metro-labs/client/api/model-order';
import { clearModelRoute, setModelRoute, type OrgModels } from '@metro-labs/client/api/org-models';
import { canAddFallback } from '@metro-labs/client/api/route-edit';
import { routeHash } from '@metro-labs/client/route';
import { PageTitle } from './PageTitle.js';
import { Loading } from './Loading.js';
import { ModelReadError } from './ModelUsage.js';
import { ModelRouting } from './ModelRouting.js';
import { RouteEditor, type RouteScope } from './RouteEditor.js';
import { TextLink } from './TextLink.js';
import { useRouteControl } from './route-actions.js';
import { editNote, sourceLine, withRoute } from './model-view.js';
import { queryError } from '../lib/queries.js';
import { afterModelChange, useModelQuery, useOrgModelsQuery } from '../lib/model-queries.js';
import { useDocumentTitle } from '../lib/title.js';

const MODEL_NOTE = 'The models your agent uses, in order. It uses the first one under 95% usage, and goes back when limits reset.';
const MEMBER_NOTE = 'Only an admin of the organization can change the model order.';
const NOT_ENROLLED = 'Enroll this agent with the organization to use its models. Until then it has no model.';
const SYNC_FAILED = 'Could not reach the organization’s models, so the agent keeps the last setup it had.';
const NO_CONNECTION = 'No connection yet. Add one on the organization’s Models page, a Claude subscription included.';

function useAgentScope(org: OrgModels, agent: string): RouteScope {
  const client = useQueryClient();
  return {
    route: org.agents[agent] ?? org.default,
    connections: org.connections,
    empty: <Text size="md" role="secondary">{NO_CONNECTION}</Text>,
    save: async (route: ModelRoute) => {
      await setModelRoute(agent, route);
      await afterModelChange(client);
    },
  };
}

function OrderEditor({ settings, org, agent }: { settings: ModelSettings; org: OrgModels; agent: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const scope = useAgentScope(org, agent);
  const control = useRouteControl(scope.route, scope.save);
  const own = org.agents[agent] !== undefined;
  const shown = withRoute(settings, scope.route, scope.connections);
  const reset = (): void => {
    control.run(async () => {
      await clearModelRoute(agent);
      await afterModelChange(client);
    }, 'Could not go back to the organization’s order.');
  };
  return (
    <Col gap={12}>
      <ModelRouting title="Model order" note={editNote(own, scope.route)} items={modelOrder(shown)} busy={control.busy} canAdd={canAddFallback(scope.route)} withUsage actions={control.actions} />
      {control.error === null ? null : <Text size="md" role="danger">{control.error}</Text>}
      <Row gap={8} wrap>
        {own ? <Button size="md" color="secondary" dark={dark} label="Use the organization’s order" loading={control.busy} disabled={control.busy} onPress={reset} /> : null}
        {scope.route === null ? <Button size="md" dark={dark} label="Choose a model" disabled={control.busy} onPress={() => { control.actions.edit({ kind: 'primary' }); }} /> : null}
      </Row>
      <RouteEditor scope={scope} slot={control.slot} onClose={control.close} />
    </Col>
  );
}

function Order({ settings, org, orgError }: { settings: ModelSettings; org: OrgModels | undefined; orgError: Error | null }): ReactNode {
  const agent = currentServer()?.id ?? null;
  if (org !== undefined && org.admin && agent !== null) return <OrderEditor settings={settings} org={org} agent={agent} />;
  const note = [sourceLine(settings.source, settings.route), org !== undefined && !org.admin ? MEMBER_NOTE : ''].filter((part) => part !== '').join(' ');
  return (
    <Col gap={12}>
      <ModelRouting title="Model order" note={note} items={modelOrder(settings)} busy={false} canAdd={false} withUsage />
      {orgError === null ? null : <Text size="md" role="danger">{queryError(orgError, 'Could not read the organization’s models.')}</Text>}
    </Col>
  );
}

function SyncNote({ sync, project }: { sync: ModelSync | null; project: string }): ReactNode {
  if (sync === null) return null;
  if (!sync.enrolled)
    return (
      <Col gap={4}>
        <Text size="md" role="danger">{NOT_ENROLLED}</Text>
        <TextLink size="md" to={routeHash({ kind: 'server', project })}>Enroll it on the Server page</TextLink>
      </Col>
    );
  return sync.error === null ? null : <Text size="md" role="danger">{`${SYNC_FAILED} ${sync.error}`}</Text>;
}

function Live({ project }: { project: string }): ReactNode {
  const model = useModelQuery();
  const org = useOrgModelsQuery();
  if (model.data === undefined) return model.error === null ? <Loading /> : <ModelReadError error={model.error} cached={false} />;
  return (
    <Col gap={32}>
      <ModelReadError error={model.error} cached />
      <SyncNote sync={model.data.sync} project={project} />
      {model.data.reason === null ? null : <Text size="md" role="danger">{model.data.reason}</Text>}
      <Order settings={model.data} org={org.data} orgError={org.error} />
      <TextLink size="md" to={routeHash({ kind: 'org-models' })}>Connections and the default order are on the organization’s Models page</TextLink>
    </Col>
  );
}

export function ModelPage({ project }: { project: string }): ReactNode {
  useDocumentTitle('Model');
  return (
    <Col gap={32}>
      <Col gap={8}>
        <PageTitle>Model</PageTitle>
        <Text size="md" role="secondary">{MODEL_NOTE}</Text>
      </Col>
      <Live project={project} />
    </Col>
  );
}
