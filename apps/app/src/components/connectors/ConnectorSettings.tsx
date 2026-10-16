import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { deleteOrgConnector, renameOrgConnector, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import { whenLabel } from '@metro-labs/client/api/when';
import { ConfirmDialog, useConfirm } from '../DeleteMenu.js';
import { NameModal } from '../NameModal.js';
import { Group, Groups } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { RoundButton } from '../ui/RoundButton.js';
import { ConnectorFacts, KeyModal, SignInModal } from './ConnectorAccount.js';
import { copyText } from '../../lib/clipboard.js';
import { logError } from '../../lib/log.js';
import { go } from '../../lib/nav.js';
import { refreshOrgConnectors } from '../../lib/org-connector-queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';

type Open = 'sign-in' | 'key' | 'rename' | null;

interface SignIn {
  title: string;
  subtitle: string;
  bad: boolean;
  action: string | null;
  open: Open;
}

function signInOf(connector: OrgConnector): SignIn {
  if (connector.auth === 'oauth') {
    const checked = connector.verifiedAt === null ? '' : ` Checked ${whenLabel(connector.verifiedAt)}.`;
    if (connector.signIn === 'connected') return { title: 'Signed in', subtitle: `One account for the whole organization. Every agent uses it.${checked}`, bad: false, action: 'Sign in again', open: 'sign-in' };
    return { title: 'Signed out', subtitle: 'Agents cannot use it until someone signs in.', bad: true, action: 'Sign in', open: 'sign-in' };
  }
  if (connector.auth === 'header') return { title: 'Key saved', subtitle: `Sent in the ${connector.header ?? 'Authorization'} header. Every agent uses it.`, bad: false, action: 'Replace the key', open: 'key' };
  return { title: 'No sign-in', subtitle: 'This server answers without an account.', bad: false, action: null, open: null };
}

function CopyAddress({ url }: { url: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  const copy = (): void => { copyText(url).then(setCopied).catch(logError('copy-connector-url')); };
  return <RoundButton label={copied ? 'Copied' : 'Copy the address'} icon={copied ? 'check' : 'copy'} ghost onPress={copy} />;
}

function SignInGroup({ connector, admin, onOpen }: { connector: OrgConnector; admin: boolean; onOpen: (open: Open) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const state = signInOf(connector);
  const action = admin && state.action !== null ? <Button color="secondary" dark={dark} label={state.action} onPress={() => { onOpen(state.open); }} /> : undefined;
  return (
    <Group label="Sign-in">
      <Item title={state.title} subtitle={state.subtitle} subtitleTone={state.bad ? 'danger' : 'secondary'} trailing={action} chevron={false} />
    </Group>
  );
}

function Modals({ connector, open, onClose }: { connector: OrgConnector; open: Open; onClose: () => void }): ReactNode {
  const client = useQueryClient();
  return (
    <>
      {open === 'sign-in' ? <SignInModal connector={connector} onClose={onClose} /> : null}
      {open === 'key' ? <KeyModal connector={connector} onClose={onClose} /> : null}
      <NameModal key={connector.name} title="Rename connector" action="Rename" placeholder={connector.name} initial={connector.name} failure="Could not rename the connector." open={open === 'rename'} onClose={onClose}
        onSubmit={async (name) => { const row = await renameOrgConnector(connector.id, name); await refreshOrgConnectors(client); return row; }} />
    </>
  );
}

export function ConnectorSettings({ connector, admin }: { connector: OrgConnector; admin: boolean }): ReactNode {
  const client = useQueryClient();
  const technical = useTechnicalDetails();
  const [open, setOpen] = useState<Open>(null);
  const removing = useConfirm(async () => {
    await deleteOrgConnector(connector.id);
    await refreshOrgConnectors(client);
  }, 'Could not remove the connector.', () => { go({ kind: 'org-connectors' }); });
  return (
    <Groups>
      <Group label="Address">
        <Item title={connector.url} subtitle="Where the tools come from" trailing={<CopyAddress url={connector.url} />} chevron={false} />
      </Group>
      <SignInGroup connector={connector} admin={admin} onOpen={setOpen} />
      <Group label="Name">
        <Item title="Name" subtitle="What agents and people see" value={connector.name} chevron={admin} onPress={admin ? () => { setOpen('rename'); } : undefined} />
      </Group>
      {admin ? (
        <Group label="Danger">
          <Item title={`Remove ${connector.name}`} subtitle={`Every agent loses its ${connector.name} tools at once. You can add it again later.`} danger chevron={false} onPress={removing.show} />
        </Group>
      ) : (
        <Text size="xs" role="secondary">Only an admin of the organization can change this connector.</Text>
      )}
      {technical ? <ConnectorFacts connector={connector} /> : null}
      <Modals connector={connector} open={open} onClose={() => { setOpen(null); }} />
      <ConfirmDialog confirming={removing} title={`Remove ${connector.name}?`} lines={[`${connector.name} and its sign-in are removed, and every agent loses its tools at once.`]} action="Remove connector" name={connector.name} />
    </Groups>
  );
}
