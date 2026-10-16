import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { IconCheckmark1 } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconCheckmark1';
import { Glyph } from '@stage-labs/kit/react-native/glyph';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import type { ModelSettings } from '@metro-labs/client/api/model';
import type { ModelRoute } from '@metro-labs/client/api/model-route';
import { modelOrder } from '@metro-labs/client/api/model-order';
import { clearModelRoute, setModelRoute, type OrgModels } from '@metro-labs/client/api/org-models';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { routeHash } from '@metro-labs/client/route';
import { Group, Groups } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { StateBlock } from '../ui/StateBlock.js';
import { Loading } from '../Loading.js';
import { type RouteScope } from '../RouteEditor.js';
import { useRouteControl, type RouteControl } from '../route-actions.js';
import { sourceLine, withRoute } from '../model-view.js';
import { RouteOrder } from '../models/RouteOrder.js';
import { NoteRow } from './rows.js';
import { afterModelChange, useModelQuery, useOrgModelsQuery } from '../../lib/model-queries.js';
import { queryError } from '../../lib/queries.js';
import { useAgentName } from '../../lib/agent-hooks.js';
import { routeSummary } from '../../lib/settings-values.js';
import { useDocumentTitle } from '../../lib/title.js';

const NO_CONNECTION = 'No account yet. Add one on the organization’s Models page, a Claude subscription included.';
const MEMBER_NOTE = 'Only an admin of the organization can change the route.';
const NOT_ENROLLED = 'Enroll this agent with the organization to use its models. Until then it has no model. Enroll it on the Server page.';
const SYNC_FAILED = 'Could not reach the organization’s models, so the agent keeps the last setup it had.';

interface Editing {
  agent: string;
  org: OrgModels;
  own: boolean;
  control: RouteControl;
  scope: RouteScope;
}

function useEditing(org: OrgModels, agent: string): Editing {
  const client = useQueryClient();
  const scope: RouteScope = {
    route: org.agents[agent] ?? org.default,
    connections: org.connections,
    empty: <Text size="md" role="secondary">{NO_CONNECTION}</Text>,
    save: async (route: ModelRoute) => {
      await setModelRoute(agent, route);
      await afterModelChange(client);
    },
  };
  return { agent, org, own: org.agents[agent] !== undefined, control: useRouteControl(scope.route, scope.save), scope };
}

function Check(): ReactNode {
  const palette = useKitPalette();
  return <Glyph icon={IconCheckmark1} size={22} color={palette.link} />;
}

function stepName(org: OrgModels): (connection: string, model: string) => string {
  return (connection, model) => (model !== '' ? model : (org.connections.find((c) => c.id === connection)?.model ?? 'a model'));
}

function RouteChoice({ editing, name }: { editing: Editing; name: string }): ReactNode {
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
  const busy = control.busy;
  return (
    <Group label="Route">
      <Item title="Organization’s route" subtitle={routeSummary(org.default, stepName(org))} trailing={own ? undefined : <Check />} chevron={false} onPress={own && !busy ? toOrg : undefined} />
      <Item title="Own route" subtitle={own ? 'The models below' : `Models just for ${name}`} trailing={own ? <Check /> : undefined} chevron={false} onPress={own || busy ? undefined : toOwn} />
    </Group>
  );
}

function EditableModels({ editing, settings, name }: { editing: Editing; settings: ModelSettings; name: string }): ReactNode {
  const { control, scope, own } = editing;
  const items = modelOrder(withRoute(settings, scope.route, scope.connections));
  return <RouteOrder items={items} who={name} mainNote={own ? undefined : `Changing a model gives ${name} its own route.`} edit={{ control, scope }} />;
}

function ReadOnlyModels({ settings, org, orgError, name }: { settings: ModelSettings; org: OrgModels | undefined; orgError: Error | null; name: string }): ReactNode {
  const note = [sourceLine(settings.source, settings.route), org === undefined ? '' : MEMBER_NOTE].filter((part) => part !== '').join(' ');
  const error = orgError === null ? null : queryError(orgError, 'Could not read the organization’s models.');
  return <RouteOrder items={modelOrder(settings)} who={name} mainNote={note} error={error} />;
}

function Problems({ settings, error }: { settings: ModelSettings; error: Error | null }): ReactNode {
  const lines = [
    error === null ? null : 'Could not refresh the model settings. Showing the last reading.',
    settings.sync === null ? null : !settings.sync.enrolled ? NOT_ENROLLED : settings.sync.error === null ? null : `${SYNC_FAILED} ${settings.sync.error}`,
    settings.reason,
  ].filter((line): line is string => line !== null);
  if (lines.length === 0) return null;
  return (
    <Group label="Needs attention">
      {lines.map((line) => (
        <NoteRow key={line} text={line} danger />
      ))}
    </Group>
  );
}

function Editable({ org, agent, settings, name }: { org: OrgModels; agent: string; settings: ModelSettings; name: string }): ReactNode {
  const editing = useEditing(org, agent);
  return (
    <>
      <RouteChoice editing={editing} name={name} />
      <EditableModels editing={editing} settings={settings} name={name} />
    </>
  );
}

export function ModelRoutePage(): ReactNode {
  useDocumentTitle('Model');
  const model = useModelQuery();
  const org = useOrgModelsQuery();
  const name = useAgentName();
  const agent = currentServer()?.id ?? null;
  if (model.data === undefined) {
    if (model.error === null) return <Loading />;
    return <StateBlock icon="exclamationCircle" danger title="The model did not load" text={queryError(model.error, 'Could not read the model settings.')} action={{ label: 'Try again', onPress: () => { model.refetch().catch(() => undefined); } }} />;
  }
  const admin = org.data?.admin === true && agent !== null;
  return (
    <Groups>
      <Problems settings={model.data} error={model.error} />
      {admin && org.data !== undefined && agent !== null ? <Editable org={org.data} agent={agent} settings={model.data} name={name} /> : <ReadOnlyModels settings={model.data} org={org.data} orgError={org.error} name={name} />}
      <Group label="Organization">
        <Item title="Accounts and the default route" subtitle="On the organization’s Models page" href={routeHash({ kind: 'org-models' })} />
      </Group>
    </Groups>
  );
}
