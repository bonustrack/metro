import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { connectorHost, connectorLabel } from '@metro-labs/client/api/connectors';
import { assignOrgConnector, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import { activeAccount } from '@metro-labs/client/auth/account';
import { ConnectorFavicon } from '../ConnectorFavicon.js';
import { Modal, ModalText } from '../Modal.js';
import { ToolConnectors } from '../tools/ToolConnectors.js';
import { Actions } from '../ui/Actions.js';
import { Rows } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { RoundButton } from '../ui/RoundButton.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { go } from '../../lib/nav.js';
import { refreshOrgConnectors, useConnectorScope, useOrgConnectorsQuery } from '../../lib/org-connector-queries.js';
import { queryError } from '../../lib/queries.js';

interface PickerProps {
  agent: string;
  name: string;
  open: boolean;
  onClose: () => void;
}

function Choices({ free, all, busy, onPick }: { free: OrgConnector[]; all: OrgConnector[]; busy: string | null; onPick: (id: string) => void }): ReactNode {
  return (
    <Rows>
      {free.map((connector) => (
        <Item key={connector.id} title={connectorLabel(connector, all)} subtitle={busy === connector.id ? 'Adding…' : connectorHost(connector.url)} chevron={false}
          leading={<ConnectorFavicon name={connector.name} url={connector.url} size={ICON_SIZE.lg} radius={6} />} onPress={() => { onPick(connector.id); }} />
      ))}
    </Rows>
  );
}

function AddConnector({ agent, name, open, onClose }: PickerProps): ReactNode {
  const client = useQueryClient();
  const all = useOrgConnectorsQuery().data?.connectors ?? [];
  const free = all.filter((connector) => !connector.agents.some((one) => one.id === agent));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = (): void => {
    if (busy !== null) return;
    setError(null);
    onClose();
  };
  const pick = (id: string): void => {
    if (busy !== null) return;
    setBusy(id);
    setError(null);
    assignOrgConnector(id, agent)
      .then(() => refreshOrgConnectors(client))
      .then(onClose)
      .catch((err: unknown) => { setError(queryError(err, 'Could not add the connector.')); })
      .finally(() => { setBusy(null); });
  };
  const fresh = (): void => { onClose(); go({ kind: 'org-connector-new' }); };
  return (
    <Modal title="Add a connector" open={open} onClose={close}>
      <Col gap={20}>
        <ModalText>{free.length === 0 ? `${name} has every connector of the organization. Add a new one on the Connectors page.` : `Pick a connector of the organization for ${name}.`}</ModalText>
        {free.length === 0 ? null : <Choices free={free} all={all} busy={busy} onPick={pick} />}
        {error === null ? null : <Text size="md" role="danger">{error}</Text>}
        <Actions cancel={{ onPress: close, disabled: busy !== null }} main={free.length === 0 ? { label: 'New connector', onPress: fresh } : undefined} />
      </Col>
    </Modal>
  );
}

export function RemoteConnectors({ agent, name }: { agent: string; name: string }): ReactNode {
  const scope = useConnectorScope();
  const admin = activeAccount()?.role === 'admin';
  const [adding, setAdding] = useState(false);
  const add = (): void => { setAdding(true); };
  return (
    <>
      <ToolConnectors key={`${String(scope)}:${agent}`} project={agent} action={admin ? <RoundButton label="Add a connector" icon="plus" onPress={add} /> : undefined} onAdd={admin ? add : undefined} />
      <AddConnector agent={agent} name={name} open={adding} onClose={() => { setAdding(false); }} />
    </>
  );
}
