import { type ReactNode, useState } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Switch } from '@stage-labs/kit/react-native/switch';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { assignOrgConnector, unassignOrgConnector, type OrgConnector, type OrgConnectorAgent } from '@metro-labs/client/api/org-connectors';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { AgentAvatar } from './AgentAvatar.js';
import { SettingsGroup, SettingsPad, SettingsSection } from './SettingsSection.js';
import { queryError, useServersQuery } from '../lib/queries.js';

const AVATAR = 28;
const NOTE = 'Give this connector only to the agents that need it. Read-only blocks its write tools for that agent.';

interface RowProps {
  server: Server;
  held: OrgConnectorAgent | undefined;
  everyoneReadOnly: boolean;
  admin: boolean;
  busy: boolean;
  onChange: (job: () => Promise<unknown>) => void;
  connector: string;
}

function noteOf(held: OrgConnectorAgent | undefined, readOnly: boolean): string {
  if (held === undefined) return 'Does not have it';
  return readOnly ? 'Has it, read-only' : 'Has it';
}

function AgentRow({ server, held, everyoneReadOnly, admin, busy, onChange, connector }: RowProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const readOnly = everyoneReadOnly || held?.readOnly === true;
  return (
    <SettingsSection title={serverLabel(server)} note={noteOf(held, readOnly)} leading={<AgentAvatar seed={server.id} src={server.avatar} size={AVATAR} />}>
      <Row gap={20} align="center">
        {held === undefined ? null : (
          <Switch
            label="Read-only"
            checked={readOnly}
            dark={dark}
            disabled={!admin || busy || everyoneReadOnly}
            onChange={(on) => {
              onChange(() => assignOrgConnector(connector, server.id, on));
            }}
          />
        )}
        <Switch
          label="Can use"
          checked={held !== undefined}
          dark={dark}
          disabled={!admin || busy}
          onChange={(on) => {
            onChange(() => (on ? assignOrgConnector(connector, server.id, false) : unassignOrgConnector(connector, server.id)));
          }}
        />
      </Row>
    </SettingsSection>
  );
}

export function OrgConnectorAgents({ connector, admin, onChanged }: { connector: OrgConnector; admin: boolean; onChanged: () => void }): ReactNode {
  const servers = useServersQuery().data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (job: () => Promise<unknown>): void => {
    setBusy(true);
    setError(null);
    job()
      .then(onChanged)
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not change that agent.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <SettingsGroup title="Agents" note={NOTE}>
      {servers === undefined || servers.length === 0 ? (
        <SettingsPad>
          <Text size="2xs" role="secondary">{servers === undefined ? 'Loading the agents…' : 'This organization has no agent yet.'}</Text>
        </SettingsPad>
      ) : (
        servers.map((server) => (
          <AgentRow key={server.id} server={server} held={connector.agents.find((a) => a.id === server.id)} everyoneReadOnly={connector.readOnly} admin={admin} busy={busy} onChange={change} connector={connector.id} />
        ))
      )}
      {error === null ? null : (
        <SettingsPad>
          <Text size="2xs" role="danger">{error}</Text>
        </SettingsPad>
      )}
    </SettingsGroup>
  );
}
