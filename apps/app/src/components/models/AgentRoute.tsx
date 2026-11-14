import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Text } from '@stage-labs/kit/react-native/text';
import type { ModelRoute } from '@metro-labs/client/api/model-route';
import { clearModelRoute, setModelRoute, type OrgModels } from '@metro-labs/client/api/org-models';
import { routeHash } from '@metro-labs/client/route';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { type RouteScope } from '../RouteEditor.js';
import { useRouteControl, type RouteControl } from '../route-actions.js';
import { Check } from './RouteParts.js';
import { GatewayUsage } from './GatewayUsage.js';
import { afterModelChange } from '../../lib/model-queries.js';
import { routeSummary } from '../../lib/settings-values.js';

const NO_CONNECTION = 'No account yet. Add one on the organization’s Gateway page, a Claude subscription included.';
export const MEMBER_NOTE = 'Only an admin of the organization can change the route.';

export interface Editing {
  agent: string;
  org: OrgModels;
  own: boolean;
  control: RouteControl;
  scope: RouteScope;
}

export function useEditing(org: OrgModels, agent: string): Editing {
  const client = useQueryClient();
  const scope: RouteScope = {
    route: org.agents[agent] ?? org.default,
    connections: org.connections,
    empty: <Text size="md" color="secondary">{NO_CONNECTION}</Text>,
    save: async (route: ModelRoute) => {
      await setModelRoute(agent, route);
      await afterModelChange(client);
    },
  };
  return { agent, org, own: org.agents[agent] !== undefined, control: useRouteControl(scope.route, scope.save), scope };
}

export const ownNote = (editing: Editing, name: string): string | undefined => (editing.own ? undefined : `Changing a model or the effort gives ${name} its own route.`);

function stepName(org: OrgModels): (connection: string, model: string) => string {
  return (connection, model) => (model !== '' ? model : (org.connections.find((c) => c.id === connection)?.model ?? 'a model'));
}

interface RouteSwitch {
  toOrg?: () => void;
  toOwn?: () => void;
}

function useRouteSwitch(editing: Editing, locked: boolean): RouteSwitch {
  const client = useQueryClient();
  const { org, own, control, agent } = editing;
  const toOrg = (): void => {
    control.run(async () => {
      await clearModelRoute(agent);
      await afterModelChange(client);
    }, 'Could not go back to the organization’s route.');
  };
  const toOwn = (): void => {
    const base = org.default;
    if (base === null) {
      control.actions.edit({ kind: 'primary' });
      return;
    }
    control.run(() => editing.scope.save(base), 'Could not give this agent its own route.');
  };
  if (locked || control.busy) return {};
  return own ? { toOrg } : { toOwn };
}

export function RouteChoice({ editing, name, locked = false }: { editing: Editing; name: string; locked?: boolean }): ReactNode {
  const { toOrg, toOwn } = useRouteSwitch(editing, locked);
  const { org, own } = editing;
  return (
    <Group label="Route" note={locked ? MEMBER_NOTE : undefined}>
      <Item title="Organization’s route" subtitle={routeSummary(org.default, stepName(org))} trailing={own ? undefined : <Check />} chevron={false} onPress={toOrg} />
      <Item title="Own route" subtitle={own ? 'The models below' : `Models just for ${name}`} trailing={own ? <Check /> : undefined} chevron={false} onPress={toOwn} />
    </Group>
  );
}

export function UsageAndLinks({ agent }: { agent: string | null }): ReactNode {
  return (
    <>
      {agent === null ? null : <GatewayUsage agent={agent} />}
      <Group label="Organization">
        <Item title="Accounts and the default route" subtitle="On the organization’s Gateway page" href={routeHash({ kind: 'org-models' })} />
      </Group>
    </>
  );
}
