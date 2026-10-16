import { type ReactNode, useState } from 'react';
import { Platform } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { removeServer, serverLabel, type Server } from '@metro-labs/client/api/servers';
import { routeHash } from '@metro-labs/client/route';
import { BootLog } from '../BootLog.js';
import { ConfirmDialog, useConfirm } from '../DeleteMenu.js';
import { type MenuItem } from '../Dropdown.js';
import { KebabMenu } from '../KebabMenu.js';
import { refreshServers } from '../../lib/queries.js';
import { openExternal } from '../../lib/open.js';
import { go } from '../../lib/nav.js';

function openTerminal(project: string): void {
  const target = { kind: 'terminal', project } as const;
  if (Platform.OS === 'web') openExternal(`${window.location.pathname}${routeHash(target)}`);
  else go(target);
}

export function AgentMenu({ server }: { server: Server }): ReactNode {
  const client = useQueryClient();
  const [bootLog, setBootLog] = useState<Server | null>(null);
  const name = serverLabel(server);
  const removing = useConfirm(
    async () => {
      await removeServer(server.id);
      await refreshServers(client);
    },
    'Could not remove the agent.',
    () => {
      go({ kind: 'servers' });
    },
  );
  const items: MenuItem[] = [
    { label: 'Restart or update', icon: 'server', onSelect: () => { go({ kind: 'server', project: server.id }); } },
    { label: 'Terminal', icon: 'desktop', onSelect: () => { openTerminal(server.id); } },
    { label: 'Back up or restore', icon: 'folder', onSelect: () => { go({ kind: 'agent-settings', project: server.id }); } },
    ...(server.instanceId === null ? [] : [{ label: 'Boot log', icon: 'documentText' as const, onSelect: () => { setBootLog(server); } }]),
    { label: `Remove ${name} from the list`, danger: true, onSelect: removing.show },
  ];
  return (
    <>
      <KebabMenu items={items} label={`Actions for ${name}`} size="lg" />
      <BootLog server={bootLog} onClose={() => { setBootLog(null); }} />
      <ConfirmDialog confirming={removing} title="Remove this agent?" lines={[`${name} leaves your list. The server keeps running and nothing on it is deleted.`]} action="Remove agent" />
    </>
  );
}
