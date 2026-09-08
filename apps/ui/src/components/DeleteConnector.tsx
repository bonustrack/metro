import { type ReactNode } from 'react';
import { type Connector } from '../api/connectors.js';
import { type MenuItem } from './Dropdown.js';
import { KebabMenu } from './KebabMenu.js';

interface DeleteConnectorProps {
  connector: Connector;
  onDelete: (id: string) => Promise<void>;
  onError: (message: string) => void;
  extra?: MenuItem[];
}

export function DeleteConnector({
  connector,
  onDelete,
  onError,
  extra = [],
}: DeleteConnectorProps): ReactNode {
  const remove = (): void => {
    onDelete(connector.id).catch((err: unknown) => {
      onError(
        err instanceof Error ? err.message : 'Could not remove the connector.',
      );
    });
  };

  return (
    <KebabMenu
      label="Connector actions"
      size="lg"
      items={[...extra, { label: 'Remove', danger: true, onSelect: remove }]}
    />
  );
}
