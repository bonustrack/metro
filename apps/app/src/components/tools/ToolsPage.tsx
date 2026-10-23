import { type ReactNode } from 'react';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { AccessKeys } from './AccessKeys.js';
import { Groups } from '../ui/Group.js';
import { ToolConnectors } from './ToolConnectors.js';
import { useConnectorScope } from '../../lib/org-connector-queries.js';
import { useDocumentTitle } from '../../lib/title.js';

export function ToolsPage({ project }: { project: string }): ReactNode {
  const scope = useConnectorScope();
  const agent = currentServer()?.id ?? '';
  useDocumentTitle('Connectors');
  return (
    <Groups>
      <ToolConnectors key={`${String(scope)}:${agent}`} project={project} />
      <AccessKeys key={`${String(scope)}:${agent}`} agent={agent} />
    </Groups>
  );
}
