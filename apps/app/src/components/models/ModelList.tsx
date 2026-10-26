import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import type { OrgModelConnection, OrgModels } from '@metro-labs/client/api/org-models';
import { providerInfo } from '@metro-labs/client/api/providers';
import { routeHash } from '@metro-labs/client/route';
import { boxesOf } from '@metro-labs/client/api/servers';
import { Icon, type IconName } from '../Icon.js';
import { ProviderLogo } from '../ProviderLogo.js';
import { ErrorState } from '../ui/ErrorState.js';
import { RoundButton } from '../ui/RoundButton.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { ListPaneRow } from '../ui/ListPaneRow.js';
import { ListPane } from '../shell/ListPane.js';
import { TabRoot } from '../shell/TabRoot.js';
import { OpenRouterNote, useOpenRouterReturn } from './OpenRouterReturn.js';
import { technicalLine } from '../../lib/agent-line.js';
import { accountLine, agentsWord, routeSummary } from '../../lib/model-words.js';
import { useOrgModelsQuery } from '../../lib/model-queries.js';
import { useConnectorScope } from '../../lib/org-connector-queries.js';
import { queryError, useServersQuery } from '../../lib/queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useDocumentTitle } from '../../lib/title.js';
import { go } from '../../lib/nav.js';

const ICON = 24;

const styles = StyleSheet.create({ mark: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' } });

export type ModelPick = { kind: 'route' } | { kind: 'usage' } | { kind: 'account'; id: string } | null;

const USAGE_LINE = 'Spend and model calls through gateway.metro.box';

function RouteMark({ icon = 'route' }: { icon?: IconName }): ReactNode {
  const palette = useKitPalette();
  return (
    <View style={styles.mark}>
      <Icon name={icon} size={ICON} color={palette.link} />
    </View>
  );
}

function AccountMark({ connection }: { connection: OrgModelConnection }): ReactNode {
  return (
    <View style={styles.mark}>
      <ProviderLogo provider={providerInfo(connection.provider)} size={ICON} />
    </View>
  );
}

function useDefaultCount(list: OrgModels): number {
  const { data } = useServersQuery();
  return boxesOf(data ?? []).filter((server) => list.agents[server.id] === undefined).length;
}

function AccountRow({ connection, pane, selected }: { connection: OrgModelConnection; pane: boolean; selected: boolean }): ReactNode {
  const technical = useTechnicalDetails();
  const line = accountLine(connection);
  const href = routeHash({ kind: 'org-model', id: connection.id });
  const detail = technical ? technicalLine([connection.provider, connection.id]) : undefined;
  const tone = line.bad ? 'danger' : 'secondary';
  if (pane) return <ListPaneRow title={connection.label} line={line.text} lineTone={tone} detail={detail} avatar={<AccountMark connection={connection} />} selected={selected} href={href} />;
  return <Item title={connection.label} subtitle={line.text} subtitleTone={tone} detail={detail} leading={<AccountMark connection={connection} />} href={href} />;
}

function PaneLabel({ text }: { text: string }): ReactNode {
  return (
    <Column padding={{ x: 12, top: 28, bottom: 8 }}>
      <Text size="xs" color="secondary">{text}</Text>
    </Column>
  );
}

function Lists({ list, pane, pick }: { list: OrgModels; pane: boolean; pick: ModelPick }): ReactNode {
  const count = useDefaultCount(list);
  const accounts = list.connections.map((c) => <AccountRow key={c.id} connection={c} pane={pane} selected={pick?.kind === 'account' && pick.id === c.id} />);
  const href = routeHash({ kind: 'org-route' });
  const usage = routeHash({ kind: 'org-usage' });
  if (pane)
    return (
      <Column>
        <ListPaneRow title="Default route" line={routeSummary(list.default)} avatar={<RouteMark />} selected={pick?.kind === 'route'} href={href} />
        <ListPaneRow title="Usage" line={USAGE_LINE} avatar={<RouteMark icon="chart" />} selected={pick?.kind === 'usage'} href={usage} />
        <PaneLabel text="Accounts" />
        {accounts.length === 0 ? <Column padding={{ x: 12 }}><Text size="xs" color="secondary">No account yet.</Text></Column> : accounts}
      </Column>
    );
  return (
    <Column gap={40}>
      <Group>
        <Item title="Default route" subtitle={routeSummary(list.default)} leading={<RouteMark />} value={agentsWord(count)} href={href} />
        <Item title="Usage" subtitle={USAGE_LINE} leading={<RouteMark icon="chart" />} href={usage} />
      </Group>
      <Group label="Accounts" note={accounts.length === 0 ? 'No account yet. Add a Claude subscription, ChatGPT, OpenRouter, Routeway, an Anthropic key or Amazon Bedrock.' : undefined}>{accounts}</Group>
    </Column>
  );
}

function Body({ pane, pick }: { pane: boolean; pick: ModelPick }): ReactNode {
  const { data, error, refetch } = useOrgModelsQuery();
  if (error !== null)
    return (
      <Column padding={pane ? { x: 12, top: 12 } : undefined}>
        <ErrorState title="Could not load the models" text={queryError(error, 'Metro did not answer.')} onRetry={refetch} />
      </Column>
    );
  if (data === undefined) return <RowsSkeleton rows={3} pane={pane} trailing={false} />;
  return <Lists list={data} pane={pane} pick={pick} />;
}

function PageBody(): ReactNode {
  const back = useOpenRouterReturn();
  return (
    <Column gap={24}>
      <OpenRouterNote back={back} />
      <Body pane={false} pick={null} />
    </Column>
  );
}

function AddAccount(): ReactNode {
  return <RoundButton label="Add an account" icon="plus" onPress={() => { go({ kind: 'org-model-add' }); }} />;
}

function useAdmin(): boolean {
  return useOrgModelsQuery().data?.admin === true;
}

export function ModelList({ pane, pick = null }: { pane: boolean; pick?: ModelPick }): ReactNode {
  const scope = useConnectorScope();
  const admin = useAdmin();
  if (pane)
    return (
      <ListPane title="Gateway" action={admin ? <AddAccount /> : undefined}>
        <Body key={scope} pane pick={pick} />
      </ListPane>
    );
  return <ModelsRoot scope={scope} admin={admin} />;
}

function ModelsRoot({ scope, admin }: { scope: number; admin: boolean }): ReactNode {
  useDocumentTitle('Gateway');
  return (
    <TabRoot title="Gateway" action={admin ? <AddAccount /> : undefined}>
      <PageBody key={scope} />
    </TabRoot>
  );
}
