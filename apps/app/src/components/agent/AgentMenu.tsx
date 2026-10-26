import { type ReactNode, useState } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { activeAccount } from '@metro-labs/client/auth/account';
import { canDeleteServer, DeleteServerDialog } from '../DeleteServer.js';
import { type MenuItem } from '../Dropdown.js';
import { KebabMenu } from '../KebabMenu.js';
import { Modal } from '../Modal.js';
import { updateOffered, useMetroUpdate, versionFacts, type MetroUpdate } from '../MetroVersion.js';
import { RemoveDialog, useRemoveFromList } from '../settings/DangerGroup.js';
import { PowerDialogs, usePower } from '../settings/Power.js';
import { usePausing } from '../settings/ProfileGroup.js';
import { go } from '../../lib/nav.js';
import { useStationsQuery } from '../../lib/queries.js';
import { openTerminal } from '../../lib/open-terminal.js';
import { shortVersion } from '../../lib/settings-values.js';

interface Updating {
  u: MetroUpdate;
  open: boolean;
  items: MenuItem[];
  close: () => void;
}

function useUpdating(): Updating {
  const u = useMetroUpdate();
  const [asked, setAsked] = useState(false);
  const [seen, setSeen] = useState<string | null>(null);
  const latest = u.release.data?.latest;
  const offered = updateOffered(versionFacts(u), u) && latest !== undefined && !u.busy;
  const items: MenuItem[] = offered ? [{ label: `Update to ${shortVersion(latest)}`, icon: 'arrowUp', onSelect: () => { setAsked(true); u.update(); } }] : [];
  const open = asked || (u.error !== null && u.error !== seen);
  return { u, open, items, close: () => { setAsked(false); setSeen(u.error); } };
}

function UpdateDialog({ updating, name }: { updating: Updating; name: string }): ReactNode {
  const { u, open, close } = updating;
  return (
    <Modal title={`Update ${name}`} open={open} onClose={close}>
      <Column gap={14}>
        {u.status === null ? null : <Text size="md" color="secondary">{u.status}</Text>}
        {u.error === null ? null : <Text size="md" color="danger">{u.error}</Text>}
        <Row justify="end">
          <Button color="secondary" label="Close" onPress={close} />
        </Row>
      </Column>
    </Modal>
  );
}

export function AgentMenu({ server }: { server: Server }): ReactNode {
  const power = usePower();
  const pausing = usePausing();
  const removing = useRemoveFromList(server);
  const updating = useUpdating();
  const exportable = useStationsQuery().data?.agent !== undefined;
  const admin = activeAccount()?.role === 'admin';
  const [deleting, setDeleting] = useState(false);
  const name = serverLabel(server);
  const items: MenuItem[] = [
    { label: 'Restart', icon: 'server', onSelect: () => { power.ask('restart'); } },
    ...updating.items,
    ...(pausing.shown && admin ? [{ label: pausing.paused ? 'Resume messages' : 'Pause messages', icon: pausing.paused ? ('play' as const) : ('pause' as const), onSelect: () => { pausing.toggle(!pausing.paused); } }] : []),
    { label: 'Terminal', icon: 'desktop', onSelect: () => { openTerminal(server.id); } },
    ...(exportable ? [{ label: 'Backup', icon: 'folder' as const, onSelect: () => { go({ kind: 'backup', project: server.id }); } }] : []),
    canDeleteServer(server)
      ? { label: `Delete ${name}`, danger: true, onSelect: () => { setDeleting(true); } }
      : { label: 'Remove from Metro', danger: true, onSelect: removing.show },
  ];
  return (
    <>
      <KebabMenu items={items} label={`Actions for ${name}`} />
      <PowerDialogs power={power} name={name} />
      <UpdateDialog updating={updating} name={name} />
      {deleting ? <DeleteServerDialog server={server} onClose={() => { setDeleting(false); }} /> : null}
      <RemoveDialog server={server} confirming={removing} />
    </>
  );
}
