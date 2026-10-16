import { type ReactNode, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Text } from '@stage-labs/kit/react-native/text';
import type { ModelRoute } from '@metro-labs/client/api/model-route';
import { clearModelRoute, setModelRoute, type OpenRouterReturn, type OrgModels } from '@metro-labs/client/api/org-models';
import { routeItems } from '@metro-labs/client/api/model-order';
import { serverLabel } from '@metro-labs/client/api/servers';
import { routeHash } from '@metro-labs/client/route';
import { AgentAvatar } from '../AgentAvatar.js';
import { ConfirmDialog, useConfirm } from '../DeleteMenu.js';
import { KebabMenu } from '../KebabMenu.js';
import { Loading } from '../Loading.js';
import { ProviderModal, type Editing } from '../ProviderModal.js';
import { type RouteScope } from '../RouteEditor.js';
import { useRouteControl } from '../route-actions.js';
import { Group, Groups } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { PageHeader } from '../ui/PageHeader.js';
import { StateBlock } from '../ui/StateBlock.js';
import { AvatarStack, serverNames } from './RouteParts.js';
import { RouteOrder } from './RouteOrder.js';
import { afterModelChange, useOrgModelsQuery } from '../../lib/model-queries.js';
import { agentsWord, namesLine, routeSummary } from '../../lib/model-words.js';
import { useConnectorScope } from '../../lib/org-connector-queries.js';
import { queryError, useServersQuery } from '../../lib/queries.js';
import { takeInitialOpenRouterReturn } from '../../lib/location.js';
import { useDocumentTitle } from '../../lib/title.js';
import { logError } from '../../lib/log.js';

const MEMBER_NOTE = 'Only an admin of the organization can change the models.';
const NO_ACCOUNT = 'Add a Claude subscription, ChatGPT, OpenRouter, an Anthropic key or Amazon Bedrock first. Then choose the model every agent uses.';

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
  return <Text size="md" role="secondary">OpenRouter is connected. Pick one of its models below.</Text>;
}

function useScope(list: OrgModels): RouteScope {
  const client = useQueryClient();
  return {
    route: list.default,
    connections: list.connections,
    empty: <Text size="md" role="secondary">Add an account first.</Text>,
    save: async (route: ModelRoute) => {
      await setModelRoute(null, route);
      await afterModelChange(client);
    },
  };
}

function Route({ list }: { list: OrgModels }): ReactNode {
  const scope = useScope(list);
  const control = useRouteControl(scope.route, scope.save);
  const items = list.default === null ? [] : routeItems(list.default, list.connections);
  return <RouteOrder items={items} who="An agent" edit={list.admin ? { control, scope } : undefined} />;
}

function Agents({ list }: { list: OrgModels }): ReactNode {
  const { data } = useServersQuery();
  const servers = data ?? [];
  const shared = servers.filter((server) => list.agents[server.id] === undefined);
  const own = servers.filter((server) => list.agents[server.id] !== undefined);
  return (
    <>
      <Group label="Used by">
        <Item title={agentsWord(shared.length)} subtitle={shared.length === 0 ? 'Every agent has its own route.' : namesLine(serverNames(shared))} leading={shared.length === 0 ? undefined : <AvatarStack servers={shared} />} />
      </Group>
      {own.length === 0 ? null : (
        <Group label="Own route" note="These agents use their own route. Change it on the agent's Settings, Model.">
          {own.map((server) => (
            <Item key={server.id} title={serverLabel(server)} subtitle={routeSummary(list.agents[server.id] ?? null)}
              leading={<AgentAvatar seed={server.host} src={server.avatar} size={28} />} href={routeHash({ kind: 'model', project: server.id })} />
          ))}
        </Group>
      )}
    </>
  );
}

function RemoveMenu(): ReactNode {
  const client = useQueryClient();
  const removing = useConfirm(async () => {
    await clearModelRoute(null);
    await afterModelChange(client);
  }, 'Could not remove the default route.');
  return (
    <>
      <KebabMenu size="lg" label="Default route menu" items={[{ label: 'Remove the default route', danger: true, onSelect: removing.show }]} />
      <ConfirmDialog confirming={removing} title="Remove the default route?" lines={['Agents without their own route have no model until you choose a new one.']} action="Remove" />
    </>
  );
}

function NoAccount({ admin }: { admin: boolean }): ReactNode {
  const [editing, setEditing] = useState<Editing | null>(null);
  return (
    <>
      <StateBlock icon="sparkle" title="No account yet" text={NO_ACCOUNT} action={admin ? { label: 'Add an account', primary: true, onPress: () => { setEditing({ provider: null, connection: null }); } } : undefined} />
      <ProviderModal editing={editing} onClose={() => { setEditing(null); }} />
    </>
  );
}

function Body(): ReactNode {
  const { data, error } = useOrgModelsQuery();
  const back = useOpenRouterReturn();
  useDocumentTitle('Default route');
  if (error !== null) return <Text size="md" role="danger">{queryError(error, 'Could not load the models.')}</Text>;
  if (data === undefined) return <Loading />;
  return (
    <Groups>
      <PageHeader title="Default route" subtitle={data.admin ? undefined : MEMBER_NOTE} action={data.admin && data.default !== null ? <RemoveMenu /> : undefined} />
      <ReturnNote back={back} />
      {data.connections.length === 0 && data.default === null ? <NoAccount admin={data.admin} /> : <Route list={data} />}
      <Agents list={data} />
    </Groups>
  );
}

export function DefaultRoute(): ReactNode {
  const scope = useConnectorScope();
  return <Body key={scope} />;
}
