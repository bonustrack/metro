import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Text } from '@stage-labs/kit/react-native/text';
import { connectorHost } from '@metro-labs/client/api/connectors';
import { completeOrgConnectorSignIn, renameOrgConnector, takeOrgConnectorReturn, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import { ConnectorFavicon } from './ConnectorFavicon.js';
import { KebabMenu } from './KebabMenu.js';
import { Loading } from './Loading.js';
import { NameModal } from './NameModal.js';
import { orgConnectorStatus } from './org-connector-status.js';
import { ConnectorAccount, ConnectorFacts } from './connectors/ConnectorAccount.js';
import { ConnectorAgents } from './connectors/ConnectorAgents.js';
import { ConnectorRule } from './connectors/ConnectorRule.js';
import { Groups } from './ui/Group.js';
import { PageHeader } from './ui/PageHeader.js';
import { StateBlock } from './ui/StateBlock.js';
import { technicalLine } from '../lib/agent-line.js';
import { queryError } from '../lib/queries.js';
import { refreshOrgConnectors, useConnectorScope, useOrgConnectorToolsQuery, useOrgConnectorsQuery } from '../lib/org-connector-queries.js';
import { useTechnicalDetails } from '../lib/technical.js';
import { useDocumentTitle } from '../lib/title.js';
import { logError } from '../lib/log.js';
import { takeInitialOrgConnectorReturn } from '../lib/location.js';

const ICON = 32;

interface Outcome {
  busy: boolean;
  note: string | null;
  error: string | null;
}

function useSignInReturn(onDone: () => void): Outcome {
  const [outcome, setOutcome] = useState<Outcome>({ busy: false, note: null, error: null });
  useEffect(() => {
    const back = takeInitialOrgConnectorReturn() ?? takeOrgConnectorReturn();
    if (back === null) return;
    if (back.kind === 'error') {
      setOutcome({ busy: false, note: null, error: back.error });
      return;
    }
    setOutcome({ busy: true, note: null, error: null });
    completeOrgConnectorSignIn(back.handoff)
      .then(() => {
        setOutcome({ busy: false, note: 'Signed in. Agents use the new sign-in from now on.', error: null });
        onDone();
      })
      .catch((err: unknown) => {
        setOutcome({ busy: false, note: null, error: queryError(err, 'The sign-in did not finish.') });
      });
  }, [onDone]);
  return outcome;
}

function useSubtitle(connector: OrgConnector): string {
  const technical = useTechnicalDetails();
  const tools = useOrgConnectorToolsQuery(connector.id).data;
  const count = tools === undefined ? null : `${String(tools.length)} ${tools.length === 1 ? 'tool' : 'tools'}`;
  return technicalLine([orgConnectorStatus(connector).text, count, technical ? connectorHost(connector.url) : null]);
}

function Header({ connector, admin, onChanged }: { connector: OrgConnector; admin: boolean; onChanged: () => void }): ReactNode {
  const [renaming, setRenaming] = useState(false);
  const subtitle = useSubtitle(connector);
  const menu = admin ? <KebabMenu size="lg" label={`Actions for ${connector.name}`} items={[{ label: 'Rename', onSelect: () => { setRenaming(true); } }]} /> : undefined;
  return (
    <>
      <PageHeader title={connector.name} subtitle={subtitle} leading={<ConnectorFavicon name={connector.name} url={connector.url} size={ICON} />} action={menu} />
      <NameModal key={connector.name} title="Rename connector" action="Rename" placeholder={connector.name} initial={connector.name} failure="Could not rename the connector." open={renaming}
        onClose={() => { setRenaming(false); }} onSubmit={async (name) => { const row = await renameOrgConnector(connector.id, name); onChanged(); return row; }} />
    </>
  );
}

function Notes({ outcome }: { outcome: Outcome }): ReactNode {
  return (
    <>
      {outcome.busy ? <Text size="md" role="secondary">Finishing the sign-in…</Text> : null}
      {outcome.note === null ? null : <Text size="md" role="secondary">{outcome.note}</Text>}
      {outcome.error === null ? null : <Text size="md" role="danger">{outcome.error}</Text>}
    </>
  );
}

function Body({ id }: { id: string }): ReactNode {
  const client = useQueryClient();
  const technical = useTechnicalDetails();
  const { data, error, refetch } = useOrgConnectorsQuery();
  const reload = useCallback(() => {
    refreshOrgConnectors(client).catch(logError('org-connector'));
  }, [client]);
  const outcome = useSignInReturn(reload);
  const connector = data?.connectors.find((c) => c.id === id);
  useDocumentTitle(connector?.name ?? 'Connector');
  if (error !== null) return <StateBlock icon="exclamationCircle" danger title="Could not load this connector" text={queryError(error, 'Metro did not answer.')} action={{ label: 'Retry', onPress: () => { refetch().catch(logError('org-connector')); } }} />;
  if (data === undefined) return <Loading />;
  if (connector === undefined) return <StateBlock icon="plug" title="This connector is gone" text="It is not in this organization any more." />;
  return (
    <Groups>
      <Header connector={connector} admin={data.admin} onChanged={reload} />
      <Notes outcome={outcome} />
      <ConnectorRule connector={connector} admin={data.admin} />
      <ConnectorAgents connector={connector} admin={data.admin} />
      {data.admin ? <ConnectorAccount connector={connector} /> : null}
      {technical ? <ConnectorFacts connector={connector} /> : null}
    </Groups>
  );
}

export function OrgConnectorPage({ id }: { id: string }): ReactNode {
  const scope = useConnectorScope();
  return <Body key={`${String(scope)}:${id}`} id={id} />;
}
