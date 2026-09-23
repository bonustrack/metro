import { type ReactNode } from 'react';
import { type Connector } from '../api/connectors.js';
import { type MenuItem } from './Dropdown.js';
import { DeleteMenu } from './DeleteMenu.js';

interface DeleteConnectorProps {
  connector: Connector;
  onDelete: (id: string) => Promise<void>;
  extra?: MenuItem[];
}

export function DeleteConnector({ connector, onDelete, extra = [] }: DeleteConnectorProps): ReactNode {
  return (
    <DeleteMenu
      label="Connector actions"
      items={extra}
      item="Remove"
      action="Remove connector"
      title="Remove this connector?"
      lines={[`“${connector.name}” and its sign-in are removed from this machine. Claude Code drops its tools at the next /reload-plugins --force.`]}
      failure="Could not remove the connector."
      run={() => onDelete(connector.id)}
    />
  );
}
