import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Switch } from '@stage-labs/kit/react-native/switch';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { deleteOrgModel, updateOrgModel, type OrgModelConnection, type OrgModels } from '@metro-labs/client/api/org-models';
import { providerInfo } from '@metro-labs/client/api/providers';
import { serverLabel } from '@metro-labs/client/api/servers';
import { whenLabel } from '@metro-labs/client/api/when';
import { routeHash } from '@metro-labs/client/route';
import { AgentAvatar } from '../AgentAvatar.js';
import { REVOKE_NOTE } from '../ClaudeConnect.js';
import { ConfirmDialog, useConfirm } from '../DeleteMenu.js';
import { Icon } from '../Icon.js';
import { NameModal } from '../NameModal.js';
import { ProviderLogo } from '../ProviderLogo.js';
import { Group, Groups } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { PageHeader } from '../ui/PageHeader.js';
import { ErrorState } from '../ui/ErrorState.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { StateBlock } from '../ui/StateBlock.js';
import { afterModelChange, useOrgModelsQuery } from '../../lib/model-queries.js';
import { accountKind, accountLine, routeSummary, signInTitle, usesConnection } from '../../lib/model-words.js';
import { useConnectorScope } from '../../lib/org-connector-queries.js';
import { queryError, useServersQuery } from '../../lib/queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useDocumentTitle } from '../../lib/title.js';
import { go } from '../../lib/nav.js';
import { AVATAR_SIZE, ICON_SIZE } from '../ui/sizes.js';

const ZDR_NOTE = 'Only OpenRouter providers that keep no prompts. A model with no such provider stops answering.';

function headerLine(connection: OrgModelConnection): string {
  const kind = accountKind(connection);
  return [kind === connection.label ? null : kind, accountLine(connection).text].filter((part): part is string => part !== null).join(' · ');
}

function ZeroRetention({ connection }: { connection: OrgModelConnection }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const change = (zdr: boolean): void => {
    setError(null);
    updateOrgModel(connection.id, { zdr }).then(() => afterModelChange(client)).catch((err: unknown) => { setError(queryError(err, 'Could not change zero data retention.')); });
  };
  return <Item title="Zero data retention" subtitle={error ?? ZDR_NOTE} subtitleTone={error === null ? 'secondary' : 'danger'} trailing={<Switch name="Zero data retention" checked={connection.zdr} dark={dark} onChange={change} />} />;
}

function UsedIn({ list, connection }: { list: OrgModels; connection: OrgModelConnection }): ReactNode {
  const palette = useKitPalette();
  const { data } = useServersQuery();
  const agents = (data ?? []).filter((server) => usesConnection(list.agents[server.id] ?? null, connection.id));
  const shared = usesConnection(list.default, connection.id);
  return (
    <Group label="Used in" note={!shared && agents.length === 0 ? 'No route uses it yet. Pick it in the default route or in an agent’s own route.' : undefined}>
      {shared ? <Item title="Default route" subtitle={routeSummary(list.default)} leading={<Icon name="route" size={ICON_SIZE.lg} color={palette.link} />} href={routeHash({ kind: 'org-route' })} /> : null}
      {agents.map((server) => (
        <Item key={server.id} title={serverLabel(server)} subtitle={routeSummary(list.agents[server.id] ?? null)} leading={<AgentAvatar seed={server.host} src={server.avatar} size={AVATAR_SIZE.row} />} href={routeHash({ kind: 'model', project: server.id })} />
      ))}
    </Group>
  );
}

function Manage({ connection }: { connection: OrgModelConnection }): ReactNode {
  const client = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const removing = useConfirm(async () => {
    await deleteOrgModel(connection.id);
    await afterModelChange(client);
  }, 'Could not remove the account.', () => { go({ kind: 'org-route' }); });
  const sign = signInTitle(connection);
  const lines = [`“${connection.label}” and its key or sign-in are removed. Every route that uses it loses it.`, ...(connection.subscription ? [`${REVOKE_NOTE} https://claude.ai/settings`] : [])];
  return (
    <Group label="Account">
      <Item title="Name" value={connection.label} onPress={() => { setRenaming(true); }} />
      <Item title={sign.title} subtitle={sign.subtitle} href={routeHash({ kind: 'org-model-sign-in', id: connection.id })} />
      {connection.provider === 'openrouter' ? <ZeroRetention connection={connection} /> : null}
      <Item title={`Remove ${connection.label}`} subtitle={connection.subscription ? 'Revoke the token at claude.ai too' : 'Every route that uses it loses it'} danger chevron={false} onPress={removing.show} />
      <NameModal key={connection.label} title="Rename the account" action="Rename" placeholder={connection.label} initial={connection.label} failure="Could not rename the account." open={renaming}
        onClose={() => { setRenaming(false); }} onSubmit={async (label) => { await updateOrgModel(connection.id, { label }); await afterModelChange(client); }} />
      <ConfirmDialog confirming={removing} title="Remove this account?" lines={lines} action="Remove account" />
    </Group>
  );
}

function Facts({ connection }: { connection: OrgModelConnection }): ReactNode {
  const facts: [string, string][] = [['Connection id', connection.id], ['Provider', connection.provider], ...(connection.region === '' ? [] : [['Region', connection.region] as [string, string]]), ...(connection.createdAt === '' ? [] : [['Added', whenLabel(connection.createdAt)] as [string, string]])];
  return <Group label="Technical details">{facts.map(([title, value]) => <Item key={title} title={title} subtitle={value} />)}</Group>;
}

function Body({ id }: { id: string }): ReactNode {
  const technical = useTechnicalDetails();
  const { data, error, refetch } = useOrgModelsQuery();
  const connection = data?.connections.find((c) => c.id === id);
  useDocumentTitle(connection?.label ?? 'Account');
  if (data === undefined) return error === null ? <RowsSkeleton rows={3} /> : <ErrorState title="Could not load the models" text={queryError(error, 'Metro did not answer.')} onRetry={refetch} />;
  if (connection === undefined) return <StateBlock icon="sparkle" title="This account is gone" text="It is not in this organization any more." />;
  return (
    <Groups>
      <PageHeader title={connection.label} subtitle={headerLine(connection)} leading={<ProviderLogo provider={providerInfo(connection.provider)} size={AVATAR_SIZE.header} />} />
      {data.admin ? <Manage connection={connection} /> : <Text size="md" role="secondary">Only an admin of the organization can change the accounts.</Text>}
      <UsedIn list={data} connection={connection} />
      {technical ? <Facts connection={connection} /> : null}
    </Groups>
  );
}

export function ModelAccount({ id }: { id: string }): ReactNode {
  const scope = useConnectorScope();
  return <Body key={`${String(scope)}:${id}`} id={id} />;
}
