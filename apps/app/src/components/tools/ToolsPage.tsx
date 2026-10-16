import { type ReactNode } from 'react';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { Groups } from '../ui/Group.js';
import { Routines } from './Routines.js';
import { SecretKeys } from './SecretKeys.js';
import { ToolConnectors } from './ToolConnectors.js';
import { useConnectorScope } from '../../lib/org-connector-queries.js';
import { useDocumentTitle } from '../../lib/title.js';

export function ToolsPage({ project }: { project: string }): ReactNode {
  const scope = useConnectorScope();
  useDocumentTitle('Tools');
  return (
    <Groups>
      <ToolConnectors key={`${String(scope)}:${currentServer()?.id ?? ''}`} />
      <Routines project={project} />
      <SecretKeys />
    </Groups>
  );
}
