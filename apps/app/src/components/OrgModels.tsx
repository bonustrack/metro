import { type ReactNode, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import type { ModelRoute } from '@metro-labs/client/api/model-route';
import { routeItems } from '@metro-labs/client/api/model-order';
import { clearModelRoute, setModelRoute, type OpenRouterReturn, type OrgModels as OrgList } from '@metro-labs/client/api/org-models';
import { canAddFallback } from '@metro-labs/client/api/route-edit';
import { serverLabel } from '@metro-labs/client/api/servers';
import { routeHash } from '@metro-labs/client/route';
import { Frame } from './Shell.js';
import { PlainSidebar } from './PlainSidebar.js';
import { ListHeader } from './ListHeader.js';
import { ListRow } from './ListRow.js';
import { Loading } from './Loading.js';
import { AgentAvatar } from './AgentAvatar.js';
import { ModelRouting } from './ModelRouting.js';
import { RouteEditor, type RouteScope } from './RouteEditor.js';
import { OrgModelConnections } from './OrgModelConnections.js';
import { SettingsGroup, SettingsPad } from './SettingsSection.js';
import { useModelName } from './AgentModel.js';
import { useRouteControl } from './route-actions.js';
import { ConfirmDialog, useConfirm } from './DeleteMenu.js';
import { queryError, useServersQuery } from '../lib/queries.js';
import { afterModelChange, useOrgModelsQuery } from '../lib/model-queries.js';
import { useConnectorScope } from '../lib/org-connector-queries.js';
import { useDocumentTitle } from '../lib/title.js';
import { takeInitialOpenRouterReturn } from '../lib/location.js';
import { logError } from '../lib/log.js';

const MEMBER_NOTE = 'Only an admin of the organization can change the models.';
const ORDER_NOTE = 'Every agent uses this list, in order, unless it has its own. An agent uses the first model under 95% usage.';
const NO_ORDER = 'No default yet. Until you choose one, an agent without its own order has no model.';
const NO_CONNECTION = 'Add a connection below first.';
const AGENTS_NOTE = 'These agents use their own model order. Change it on the agent’s Model page.';
const REMOVE_LINES = ['Agents without their own order have no model until you choose a new default.'];

function useDefaultScope(list: OrgList): RouteScope {
  const client = useQueryClient();
  return {
    route: list.default,
    connections: list.connections,
    empty: <Text size="md" role="secondary">{NO_CONNECTION}</Text>,
    save: async (route: ModelRoute) => {
      await setModelRoute(null, route);
      await afterModelChange(client);
    },
  };
}

function DefaultOrder({ list }: { list: OrgList }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const scope = useDefaultScope(list);
  const control = useRouteControl(scope.route, scope.save);
  const actions = list.admin ? control.actions : undefined;
  if (list.default === null)
    return (
      <Col>
        <SettingsGroup title="Default model order">
          <SettingsPad>
            <Text size="md" role="secondary">{NO_ORDER}</Text>
            {list.admin ? <Row><Button size="md" dark={dark} label="Choose a model" disabled={list.connections.length === 0} onPress={() => { control.actions.edit({ kind: 'primary' }); }} /></Row> : null}
          </SettingsPad>
        </SettingsGroup>
        <RouteEditor scope={scope} slot={control.slot} onClose={control.close} />
      </Col>
    );
  return (
    <Col gap={12}>
      <ModelRouting title="Default model order" note={ORDER_NOTE} items={routeItems(list.default, list.connections)} busy={control.busy} canAdd={canAddFallback(list.default)} withUsage={false} actions={actions} />
      {control.error === null ? null : <Text size="md" role="danger">{control.error}</Text>}
      {list.admin ? <RemoveDefault /> : null}
      <RouteEditor scope={scope} slot={control.slot} onClose={control.close} />
    </Col>
  );
}

function RemoveDefault(): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const removing = useConfirm(async () => {
    await clearModelRoute(null);
    await afterModelChange(client);
  }, 'Could not remove the default order.');
  return (
    <Row>
      <Button size="md" color="secondary" dark={dark} label="Remove the default order" onPress={removing.show} />
      <ConfirmDialog confirming={removing} title="Remove the default order?" lines={REMOVE_LINES} action="Remove default" />
    </Row>
  );
}

function useOpenRouterReturn(): OpenRouterReturn | null {
  const client = useQueryClient();
  const [back] = useState(takeInitialOpenRouterReturn);
  useEffect(() => {
    if (back !== null) afterModelChange(client).catch(logError('org-models'));
  }, [back, client]);
  return back;
}

function ReturnNote({ back }: { back: OpenRouterReturn | null }): ReactNode {
  if (back === null) return null;
  if (back.kind === 'error') return <Text size="md" role="danger">{back.error}</Text>;
  return <Text size="md">OpenRouter is connected. Pick its models in the default order or in an agent’s own order.</Text>;
}

function AgentRow({ agent, route, list }: { agent: string; route: ModelRoute; list: OrgList }): ReactNode {
  const { data: servers } = useServersQuery();
  const server = servers?.find((s) => s.id === agent);
  const connection = list.connections.find((c) => c.id === route.primary.connection);
  const model = useModelName(connection, route.primary.model);
  const fallbacks = route.fallbacks.length === 0 ? '' : ` · ${String(route.fallbacks.length)} ${route.fallbacks.length === 1 ? 'fallback' : 'fallbacks'}`;
  return (
    <ListRow
      title={server === undefined ? agent : serverLabel(server)}
      detail={`${connection === undefined ? 'A connection that is gone' : `${model} on ${connection.label}`}${fallbacks}`}
      href={routeHash({ kind: 'model', project: agent })}
      icon={<AgentAvatar seed={server?.host ?? agent} src={server?.avatar ?? null} size={28} />}
    />
  );
}

function Agents({ list }: { list: OrgList }): ReactNode {
  const entries = Object.entries(list.agents);
  if (entries.length === 0) return null;
  return (
    <SettingsGroup title="Agents with their own order" note={AGENTS_NOTE}>
      {entries.map(([agent, route]) => <AgentRow key={agent} agent={agent} route={route} list={list} />)}
    </SettingsGroup>
  );
}

function Body(): ReactNode {
  const { data, error } = useOrgModelsQuery();
  const back = useOpenRouterReturn();
  return (
    <Col gap={32} width="100%">
      <Col gap={12}>
        <ListHeader title="Models" rule={false} />
        {data === undefined || data.admin ? null : <Text size="md" role="secondary">{MEMBER_NOTE}</Text>}
        <ReturnNote back={back} />
      </Col>
      {error !== null ? <Text size="md" role="danger">{queryError(error, 'Could not load the models.')}</Text> : null}
      {data === undefined ? (error === null ? <Loading /> : null) : (
        <Col gap={32}>
          <DefaultOrder list={data} />
          <OrgModelConnections list={data} />
          <Agents list={data} />
        </Col>
      )}
    </Col>
  );
}

export function OrgModels({ onLock }: { onLock: () => void }): ReactNode {
  const scope = useConnectorScope();
  useDocumentTitle('Models');
  return (
    <Frame sidebar={(closeMenu) => <PlainSidebar selection={{ kind: 'org-models' }} onSelect={closeMenu} />} onLock={onLock}>
      <Body key={scope} />
    </Frame>
  );
}
