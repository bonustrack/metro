import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Text } from './ui.js';
import { SHRINK } from '../theme.js';
import { PageTitle } from './PageTitle.js';
import { connectorHost, renameConnector, verifyConnector, type Connector } from '../api/connectors.js';
import { queryError, refreshConnectors, useConnectorQuery } from '../api/queries.js';
import { useAgentName } from '../api/agent-name.js';
import { whenLabel } from '../api/when.js';
import { BackLink } from './BackLink.js';
import { routeHash } from '../route.js';
import { ConnectorFavicon } from './ConnectorFavicon.js';
import { ConnectorPermissions } from './ConnectorPermissions.js';
import { ConfirmDialog, useConfirm } from './DeleteMenu.js';
import { FactRow, SettingsGroup, SettingsSection } from './SettingsSection.js';
import { Loading } from './Loading.js';
import { NameModal } from './NameModal.js';
import { useSignIn } from './connector-signin.js';
import { useDocumentTitle } from '../title.js';

const FALLBACK = 'Could not load this connector.';
const ICON = 32;
const AUTH_LABEL: Record<string, string> = { oauth: 'Sign-in with the service', header: 'Key in a header', none: 'None' };

function statusOf(connector: Connector): { text: string; bad: boolean } {
  if (connector.signIn === 'disconnected') return { text: 'Signed out', bad: true };
  const health = connector.health;
  if (health === null) return { text: 'Not used yet', bad: false };
  return health.ok ? { text: 'Working', bad: false } : { text: 'Not answering', bad: true };
}

function Header({ connector, project, onBack, onChanged, onError }: { connector: Connector; project: string; onBack: () => void; onChanged: () => void; onError: (m: string) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { busy, connect } = useSignIn(connector, onChanged, onError);
  const status = statusOf(connector);
  return (
    <Col gap={16}>
      <BackLink label="Connectors" href={routeHash({ kind: 'connectors', project })} onPress={onBack} />
      <Row justify="between" align="center" gap={16}>
        <Row gap={14} align="center" style={SHRINK}>
          <ConnectorFavicon name={connector.name} url={connector.url} size={ICON} />
          <Col gap={2} style={SHRINK}>
            <PageTitle>{connector.name}</PageTitle>
            <Text size="sm" role={status.bad ? 'danger' : 'secondary'} numberOfLines={1}>
              {`${connectorHost(connector.url)} · ${status.text}`}
            </Text>
          </Col>
        </Row>
        {connector.signIn === 'disconnected' ? <Button size="sm" color="primary" dark={dark} label="Connect" loading={busy} disabled={busy} onPress={connect} /> : null}
      </Row>
    </Col>
  );
}

function lastCallOf(connector: Connector): string {
  const health = connector.health;
  if (health === null) return 'None since Metro started';
  return health.ok ? whenLabel(health.at) : `${health.reason ?? 'Failed'} (${whenLabel(health.at)})`;
}

function Facts({ connector }: { connector: Connector }): ReactNode {
  const verified = connector.verified;
  const health = connector.health;
  return (
    <>
      <FactRow label="Address" value={connector.url} />
      <FactRow label="Sign-in" value={AUTH_LABEL[connector.auth] ?? 'None'} />
      <FactRow label="Last call" value={lastCallOf(connector)} danger={health !== null && !health.ok} />
      {verified === null || verified.server === '' ? null : <FactRow label="Service" value={verified.server} />}
      {connector.clientId === null ? null : <FactRow label="App id" value={connector.clientId} />}
    </>
  );
}

function Connection({ connector, onChanged }: { connector: Connector; onChanged: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const check = (): void => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    verifyConnector(connector.id)
      .then((result) => {
        setNote(result.ok ? 'It answered just now.' : (result.reason ?? 'It did not answer.'));
        onChanged();
      })
      .catch((err: unknown) => {
        setNote(queryError(err, 'Could not check the connector.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <SettingsGroup title="Connection">
      <SettingsSection title="Check the connection" note={note ?? 'Asks the service if it answers.'}>
        <Button size="sm" color="secondary" dark={dark} label={busy ? 'Checking…' : 'Check now'} disabled={busy} onPress={check} />
      </SettingsSection>
      <Facts connector={connector} />
    </SettingsGroup>
  );
}

function Manage({ connector, onDelete, onChanged, onError }: { connector: Connector; onDelete: (id: string) => Promise<void>; onChanged: () => void; onError: (m: string) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [renaming, setRenaming] = useState(false);
  const { busy, disconnect } = useSignIn(connector, onChanged, onError);
  const confirming = useConfirm(() => onDelete(connector.id), 'Could not remove the connector.');
  return (
    <SettingsGroup title="Manage">
      <SettingsSection title="Name" note={`The agent sees its tools under “${connector.name}”.`}>
        <Button size="sm" color="secondary" dark={dark} label="Rename" onPress={() => { setRenaming(true); }} />
      </SettingsSection>
      {connector.signIn === 'connected' ? (
        <SettingsSection title="Sign out" note="The agent loses access until you connect again.">
          <Button size="sm" color="secondary" dark={dark} label="Sign out" loading={busy} disabled={busy} onPress={disconnect} />
        </SettingsSection>
      ) : null}
      <SettingsSection title="Remove connector" note="Removes it and its sign-in from this agent.">
        <Button size="sm" color="danger" dark={dark} label="Remove" onPress={confirming.show} />
      </SettingsSection>
      <ConfirmDialog
        confirming={confirming}
        title="Remove this connector?"
        lines={[`“${connector.name}” and its sign-in are removed. The agent drops its tools after /reload-plugins --force.`]}
        action="Remove connector"
      />
      <NameModal
        key={connector.name}
        title="Rename connector"
        action="Rename"
        placeholder={connector.name}
        initial={connector.name}
        failure="Could not rename the connector."
        open={renaming}
        onClose={() => {
          setRenaming(false);
        }}
        onSubmit={async (name) => {
          const row = await renameConnector(connector.id, name);
          onChanged();
          return row;
        }}
      />
    </SettingsGroup>
  );
}

interface ConnectorPageProps {
  project: string;
  id: string;
  onDelete: (id: string) => Promise<void>;
  onBack: () => void;
}

export function ConnectorPage({ project, id, onDelete, onBack }: ConnectorPageProps): ReactNode {
  const client = useQueryClient();
  const { data, error } = useConnectorQuery(id);
  const [failure, setFailure] = useState<string | null>(null);
  const name = useAgentName();
  useDocumentTitle(data?.name ?? 'Connector');
  const reload = (): void => {
    setFailure(null);
    refreshConnectors(client, id);
  };
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, FALLBACK)}</Text>;
  if (data === undefined) return <Loading />;
  return (
    <Col gap={32}>
      <Header connector={data} project={project} onBack={onBack} onChanged={reload} onError={setFailure} />
      {failure === null ? null : <Text size="sm" role="danger">{failure}</Text>}
      <ConnectorPermissions connector={data} title={`What ${name} may do`} />
      <Connection connector={data} onChanged={reload} />
      <Manage connector={data} onDelete={onDelete} onChanged={reload} onError={setFailure} />
    </Col>
  );
}
