import { type ReactNode, useState } from 'react';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { canDeleteServer, DeleteServerDialog } from '../DeleteServer.js';
import { type MenuItem } from '../Dropdown.js';
import { KebabMenu } from '../KebabMenu.js';
import { updateOffered, useMetroUpdate, versionFacts } from '../MetroVersion.js';
import { TransferDialogs, type Transfer } from '../settings/AdvancedGroup.js';
import { RemoveDialog, useRemoveFromList } from '../settings/DangerGroup.js';
import { PowerDialogs, usePower } from '../settings/Power.js';
import { usePausing } from '../settings/ProfileGroup.js';
import { useStationsQuery } from '../../lib/queries.js';
import { openTerminal } from '../../lib/open-terminal.js';
import { shortVersion } from '../../lib/settings-values.js';

function useUpdateItem(): MenuItem[] {
  const u = useMetroUpdate();
  const latest = u.release.data?.latest;
  if (!updateOffered(versionFacts(u), u) || latest === undefined || u.busy) return [];
  return [{ label: `Update to ${shortVersion(latest)}`, icon: 'arrowUp', onSelect: u.update }];
}

export function AgentMenu({ server }: { server: Server }): ReactNode {
  const power = usePower();
  const pausing = usePausing();
  const removing = useRemoveFromList(server);
  const update = useUpdateItem();
  const exportable = useStationsQuery().data?.agent !== undefined;
  const [transfer, setTransfer] = useState<Transfer>(null);
  const [deleting, setDeleting] = useState(false);
  const name = serverLabel(server);
  const items: MenuItem[] = [
    { label: 'Restart', icon: 'server', onSelect: () => { power.ask('restart'); } },
    ...update,
    ...(pausing.shown ? [{ label: pausing.paused ? 'Resume messages' : 'Pause messages', icon: pausing.paused ? ('play' as const) : ('pause' as const), onSelect: () => { pausing.toggle(!pausing.paused); } }] : []),
    { label: 'Terminal', icon: 'desktop', onSelect: () => { openTerminal(server.id); } },
    ...(exportable ? [{ label: 'Export', icon: 'folder' as const, onSelect: () => { setTransfer('export'); } }] : []),
    canDeleteServer(server)
      ? { label: `Delete ${name}`, danger: true, onSelect: () => { setDeleting(true); } }
      : { label: `Remove ${name} from the list`, danger: true, onSelect: removing.show },
  ];
  return (
    <>
      <KebabMenu items={items} label={`Actions for ${name}`} size="lg" />
      <PowerDialogs power={power} name={name} />
      <TransferDialogs server={server} step={transfer} onStep={setTransfer} />
      {deleting ? <DeleteServerDialog server={server} onClose={() => { setDeleting(false); }} /> : null}
      <RemoveDialog server={server} confirming={removing} />
    </>
  );
}
