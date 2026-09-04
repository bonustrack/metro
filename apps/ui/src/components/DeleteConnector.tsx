import { type ReactNode } from 'react';
import { type Connector } from '../api/connectors';
import { type MenuItem } from './Dropdown';
import { KebabMenu } from './KebabMenu';

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
