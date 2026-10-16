import { type ReactNode, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import type { OrgModelConnection, OrgModels } from '@metro-labs/client/api/org-models';
import { providerInfo } from '@metro-labs/client/api/providers';
import { routeHash } from '@metro-labs/client/route';
import { Icon } from '../Icon.js';
import { Loading } from '../Loading.js';
import { ProviderLogo } from '../ProviderLogo.js';
import { ProviderModal, type Editing } from '../ProviderModal.js';
import { RoundButton } from '../RoundButton.js';
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

const ICON = 24;
const PLUS = 20;

const styles = StyleSheet.create({ mark: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' } });

export type ModelPick = { kind: 'route' } | { kind: 'account'; id: string } | null;

function RouteMark(): ReactNode {
  const palette = useKitPalette();
  return (
    <View style={styles.mark}>
      <Icon name="route" size={ICON} color={palette.link} />
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
  return (data ?? []).filter((server) => list.agents[server.id] === undefined).length;
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
    <Col padding={{ x: 12, top: 28, bottom: 8 }}>
      <Text size="xs" role="secondary">{text}</Text>
    </Col>
  );
}

function Lists({ list, pane, pick }: { list: OrgModels; pane: boolean; pick: ModelPick }): ReactNode {
  const count = useDefaultCount(list);
  const accounts = list.connections.map((c) => <AccountRow key={c.id} connection={c} pane={pane} selected={pick?.kind === 'account' && pick.id === c.id} />);
  const href = routeHash({ kind: 'org-route' });
  if (pane)
    return (
      <Col>
        <ListPaneRow title="Default route" line={routeSummary(list.default)} avatar={<RouteMark />} selected={pick?.kind === 'route'} href={href} />
        <PaneLabel text="Accounts" />
        {accounts.length === 0 ? <Col padding={{ x: 12 }}><Text size="xs" role="secondary">No account yet.</Text></Col> : accounts}
      </Col>
    );
  return (
    <Col gap={40}>
      <Group>
        <Item title="Default route" subtitle={routeSummary(list.default)} leading={<RouteMark />} value={agentsWord(count)} href={href} />
      </Group>
      <Group label="Accounts" note={accounts.length === 0 ? 'No account yet. Add a Claude subscription, ChatGPT, OpenRouter, an Anthropic key or Amazon Bedrock.' : undefined}>{accounts}</Group>
    </Col>
  );
}

function Body({ pane, pick }: { pane: boolean; pick: ModelPick }): ReactNode {
  const { data, error } = useOrgModelsQuery();
  if (error !== null) return <Text size="md" role="danger">{queryError(error, 'Could not load the models.')}</Text>;
  if (data === undefined) return <Loading />;
  return <Lists list={data} pane={pane} pick={pick} />;
}

function PageBody(): ReactNode {
  const back = useOpenRouterReturn();
  return (
    <Col gap={24}>
      <OpenRouterNote back={back} />
      <Body pane={false} pick={null} />
    </Col>
  );
}

export function AddAccount({ size }: { size: number }): ReactNode {
  const palette = useKitPalette();
  const [editing, setEditing] = useState<Editing | null>(null);
  return (
    <>
      <RoundButton label="Add an account" size={size} onPress={() => { setEditing({ provider: null, connection: null }); }}>
        <Icon name="plus" size={PLUS} color={palette.link} />
      </RoundButton>
      <ProviderModal editing={editing} onClose={() => { setEditing(null); }} />
    </>
  );
}

function useAdmin(): boolean {
  return useOrgModelsQuery().data?.admin === true;
}

export function ModelList({ pane, pick = null }: { pane: boolean; pick?: ModelPick }): ReactNode {
  const scope = useConnectorScope();
  const admin = useAdmin();
  if (pane)
    return (
      <ListPane title="Models" action={admin ? <AddAccount size={36} /> : undefined}>
        <Body key={scope} pane pick={pick} />
      </ListPane>
    );
  return <ModelsRoot scope={scope} admin={admin} />;
}

function ModelsRoot({ scope, admin }: { scope: number; admin: boolean }): ReactNode {
  useDocumentTitle('Models');
  return (
    <TabRoot title="Models" action={admin ? <AddAccount size={40} /> : undefined}>
      <PageBody key={scope} />
    </TabRoot>
  );
}
