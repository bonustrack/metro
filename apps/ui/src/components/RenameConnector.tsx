import { type ReactNode } from 'react';
import { renameConnector, type Connector } from '../api/connectors';
import { NameModal } from './NameModal';

interface RenameConnectorProps {
  token: string;
  connector: Connector;
  open: boolean;
  onClose: () => void;
  onRenamed: () => void;
}

export function RenameConnector({
  token,
  connector,
  open,
  onClose,
  onRenamed,
}: RenameConnectorProps): ReactNode {
  return (
    <NameModal
      title="Rename connector"
      action="Rename"
      placeholder={connector.name}
      initial={connector.name}
      failure="Could not rename the connector."
      open={open}
      onClose={onClose}
      onSubmit={async (name) => {
        const row = await renameConnector(token, connector.id, name);
        onRenamed();
        return row;
      }}
    />
  );
}
