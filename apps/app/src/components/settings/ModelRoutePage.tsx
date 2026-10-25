import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import type { ModelSettings, ProviderInfo } from '@metro-labs/client/api/model';
import type { ModelRoute } from '@metro-labs/client/api/model-route';
import { modelOrder } from '@metro-labs/client/api/model-order';
import { clearModelRoute, setModelRoute, type OrgModels } from '@metro-labs/client/api/org-models';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { routeHash } from '@metro-labs/client/route';
import { Group, Groups } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { ErrorState } from '../ui/ErrorState.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { type RouteScope } from '../RouteEditor.js';
import { useRouteControl, type RouteControl } from '../route-actions.js';
import { helperItems, partsNeedUpdate, sourceLine, withRoute } from '../model-view.js';
import { Check } from '../models/RouteParts.js';
import { RouteSetup } from '../models/RouteSetup.js';
import { Control, NoteRow } from './rows.js';
import { useLinkWords, useRetryLink, type LinkWords } from '../../lib/auto-enroll.js';
import { afterModelChange, useModelQuery, useOrgModelsQuery } from '../../lib/model-queries.js';
import { queryError } from '../../lib/queries.js';
import { useAgentName } from '../../lib/agent-hooks.js';
import { useOutdatedProvider } from '../../lib/outdated-provider.js';
import { routeSummary } from '../../lib/settings-values.js';
import { useDocumentTitle } from '../../lib/title.js';

const NO_CONNECTION = 'No account yet. Add one on the organization’s Gateway page, a Claude subscription included.';
const MEMBER_NOTE = 'Only an admin of the organization can change the route.';
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
  const helpers = helperItems(settings, scope.route?.helpers ?? null, scope.connections);
  const note = own ? undefined : `Changing a model or the effort gives ${name} its own route.`;
  return <RouteSetup items={items} helperItems={helpers} effort={scope.route?.effort ?? {}} who={name} mainNote={note} edit={{ control, scope }} />;
}

function ReadOnlyModels({ settings, org, orgError, name }: { settings: ModelSettings; org: OrgModels | undefined; orgError: Error | null; name: string }): ReactNode {
  const note = [sourceLine(settings.source, settings.route), org === undefined ? '' : MEMBER_NOTE].filter((part) => part !== '').join(' ');
  const error = orgError === null ? null : queryError(orgError, 'Could not read the organization’s models.');
  return <RouteSetup items={modelOrder(settings)} helperItems={helperItems(settings, settings.helpers?.route ?? null)} effort={settings.effort ?? {}} who={name} mainNote={note} error={error} />;
}

function LinkRow({ words }: { words: LinkWords }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const retry = useRetryLink();
  if (words.error === null) return <NoteRow text={words.line} danger={words.danger} />;
  return (
    <Control title="This agent could not link to the organization" note={words.error} noteTone="danger">
      <Button size="sm" color="secondary" dark={dark} label="Try again" onPress={retry} />
    </Control>
  );
}

function problemLines(settings: ModelSettings, error: Error | null, linking: boolean, outdated: ProviderInfo | null): string[] {
  const syncError = linking ? null : (settings.sync?.error ?? null);
  const explained = linking || (outdated !== null && settings.route === null);
  return [
    error === null ? null : 'Could not refresh the model settings. Showing the last reading.',
    syncError === null ? null : `${SYNC_FAILED} ${syncError}`,
    explained ? null : settings.reason,
  ].filter((line): line is string => line !== null);
}

interface ProblemsProps {
  settings: ModelSettings;
  error: Error | null;
  outdated: ProviderInfo | null;
  partsOutdated: boolean;
  project: string;
}

function UpdateRow({ what, project }: { what: string; project: string }): ReactNode {
  return <Item title={`Update Metro to use ${what}`} subtitle="Open Settings, then Metro version under Server." subtitleTone="danger" href={routeHash({ kind: 'agent-settings', project })} />;
}

function Problems({ settings, error, outdated, partsOutdated, project }: ProblemsProps): ReactNode {
  const link = useLinkWords(settings.sync);
  const lines = problemLines(settings, error, link !== null, outdated);
  if (lines.length === 0 && link === null && outdated === null && !partsOutdated) return null;
  return (
    <Group label="Needs attention">
      {link === null ? null : <LinkRow words={link} />}
      {outdated === null ? null : <UpdateRow what={outdated.label} project={project} />}
      {partsOutdated ? <UpdateRow what="the worker models and the effort" project={project} /> : null}
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

export function ModelRoutePage({ project }: { project: string }): ReactNode {
  useDocumentTitle('Gateway');
  const model = useModelQuery();
  const org = useOrgModelsQuery();
  const name = useAgentName();
  const agent = currentServer()?.id ?? null;
  const outdated = useOutdatedProvider();
  if (model.data === undefined) {
    if (model.error === null) return <RowsSkeleton rows={3} />;
    return <ErrorState title="The model did not load" text={queryError(model.error, 'Could not read the model settings.')} onRetry={model.refetch} />;
  }
  const admin = org.data?.admin === true && agent !== null;
  const partsOutdated = partsNeedUpdate(model.data, org.data, agent);
  return (
    <Groups>
      <Problems settings={model.data} error={model.error} outdated={outdated} partsOutdated={partsOutdated} project={project} />
      {admin && org.data !== undefined && agent !== null ? <Editable org={org.data} agent={agent} settings={model.data} name={name} /> : <ReadOnlyModels settings={model.data} org={org.data} orgError={org.error} name={name} />}
      <Group label="Organization">
        <Item title="Accounts and the default route" subtitle="On the organization’s Gateway page" href={routeHash({ kind: 'org-models' })} />
      </Group>
    </Groups>
  );
}
