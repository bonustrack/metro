import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { claudeCommand, createAgentKey, MCP_URL, revokeAgentKey, type AgentKey, type NewAgentKey } from '@metro-labs/client/api/agent-keys';
import { whenLabel } from '@metro-labs/client/api/when';
import { activeAccount } from '@metro-labs/client/auth/account';
import { CopyBlock } from '../CopyBlock.js';
import { ConfirmDialog, useConfirm } from '../DeleteMenu.js';
import { FormField } from '../FormField.js';
import { Icon } from '../Icon.js';
import { KebabMenu } from '../KebabMenu.js';
import { Modal, ModalText } from '../Modal.js';
import { Actions } from '../ui/Actions.js';
import { ErrorState } from '../ui/ErrorState.js';
import { Group, Groups } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { RoundButton } from '../ui/RoundButton.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { StateBlock } from '../ui/StateBlock.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { queryError } from '../../lib/queries.js';
import { refreshAgentKeys, useAgentKeysQuery } from '../../lib/remote-agents.js';
import { GROW } from '../../lib/style.js';
import { useNow } from '../../lib/use-now.js';

const LABEL_MAX = 64;
const NOTE = 'A key lets Claude Code or any MCP client use this agent\'s connectors. Anyone with the key can use them, so keep it like a password.';

const iso = (at: number): string => new Date(at).toISOString();

function keyLine(key: AgentKey, now: number): string {
  if (key.revokedAt !== null) return `Revoked ${whenLabel(iso(key.revokedAt), now)}`;
  const used = key.lastUsedAt === null ? 'never used' : `last used ${whenLabel(iso(key.lastUsedAt), now)}`;
  return `Created ${whenLabel(iso(key.createdAt), now)} · ${used}`;
}

function KeyRow({ agent, item, admin, now }: { agent: string; item: AgentKey; admin: boolean; now: number }): ReactNode {
  const palette = useKitPalette();
  const client = useQueryClient();
  const revoking = useConfirm(async () => {
    await revokeAgentKey(agent, item.id);
    await refreshAgentKeys(client, agent);
  }, 'Could not revoke the key.');
  const live = item.revokedAt === null;
  return (
    <>
      <Item
        title={item.label}
        subtitle={keyLine(item, now)}
        subtitleTone={live ? 'secondary' : 'danger'}
        leading={<Icon name="key" size={ICON_SIZE.lg} color={live ? palette.text : palette.sub} />}
        chevron={false}
        trailing={admin && live ? <KebabMenu ghost label={`Actions for ${item.label}`} items={[{ label: 'Revoke', danger: true, onSelect: revoking.show }]} /> : undefined}
      />
      <ConfirmDialog confirming={revoking} title={`Revoke ${item.label}?`} lines={['Anything that uses this key loses the connectors at once. This cannot be undone.']} action="Revoke key" name={item.label} />
    </>
  );
}

function CreateKey({ agent, open, onClose, onCreated }: { agent: string; open: boolean; onClose: () => void; onCreated: (made: NewAgentKey) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const [label, setLabel] = useState('Claude Code');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = label.trim() !== '' && label.trim().length <= LABEL_MAX;
  const close = (): void => {
    if (busy) return;
    setError(null);
    onClose();
  };
  const submit = (): void => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    createAgentKey(agent, label)
      .then(async (made) => {
        await refreshAgentKeys(client, agent);
        onCreated(made);
      })
      .catch((err: unknown) => { setError(queryError(err, 'Could not create the key.')); })
      .finally(() => { setBusy(false); });
  };
  return (
    <Modal title="Create an access key" open={open} onClose={close}>
      <Col gap={20}>
        <ModalText>Name it after where you use it, like your laptop or a tool.</ModalText>
        <FormField label="Name" name="key-label" value={label} placeholder="Claude Code" disabled={busy} dark={dark} onChangeText={setLabel} onSubmit={submit} style={GROW} />
        <Actions error={error} cancel={{ onPress: close, disabled: busy }} main={{ label: 'Create key', busy, disabled: !ready, onPress: submit }} />
      </Col>
    </Modal>
  );
}

function ShownKey({ made, onClose }: { made: NewAgentKey | null; onClose: () => void }): ReactNode {
  if (made === null) return null;
  return (
    <Modal title={`${made.key.label} key`} open onClose={onClose}>
      <Col gap={20}>
        <ModalText>Copy it now. Metro shows it only once.</ModalText>
        <CopyBlock label="Key" value={made.secret} />
        <CopyBlock label="Add it to Claude Code" value={claudeCommand(made.secret)} />
        <Text size="xs" role="secondary">{`Any MCP client: URL ${MCP_URL}, header Authorization: Bearer <key>`}</Text>
        <Actions main={{ label: 'Done', onPress: onClose }} />
      </Col>
    </Modal>
  );
}

function KeyList({ agent, admin, onCreate }: { agent: string; admin: boolean; onCreate: () => void }): ReactNode {
  const { data, error, refetch } = useAgentKeysQuery(agent);
  const now = useNow(30_000);
  if (data === undefined && error !== null) return <ErrorState title="Could not read the access keys" text={queryError(error, 'Metro did not answer.')} onRetry={refetch} />;
  if (data === undefined) return <RowsSkeleton rows={2} />;
  if (data.length === 0)
    return (
      <StateBlock icon="key" title="No access keys yet" text={admin ? 'Create a key, then add it to Claude Code or any MCP client.' : 'An admin of the organization creates the keys.'}
        action={admin ? { label: 'Create a key', primary: true, onPress: onCreate } : undefined} />
    );
  return data.map((item) => <KeyRow key={item.id} agent={agent} item={item} admin={admin} now={now} />);
}

function HowTo(): ReactNode {
  return (
    <Group label="Connect a client" note="Send the key as a bearer token. Every call shows in Activity.">
      <Col gap={16} padding={{ y: 14 }}>
        <CopyBlock label="MCP server" value={MCP_URL} />
        <CopyBlock label="Header" value="Authorization: Bearer <key>" />
      </Col>
    </Group>
  );
}

export function AccessKeys({ agent }: { agent: string }): ReactNode {
  const admin = activeAccount()?.role === 'admin';
  const [creating, setCreating] = useState(false);
  const [made, setMade] = useState<NewAgentKey | null>(null);
  const create = (): void => { setCreating(true); };
  return (
    <Groups>
      <Group label="Access keys" note={NOTE} action={admin ? <RoundButton label="Create a key" icon="plus" onPress={create} /> : undefined}>
        <KeyList agent={agent} admin={admin} onCreate={create} />
      </Group>
      <HowTo />
      <CreateKey key={creating ? 'open' : 'closed'} agent={agent} open={creating} onClose={() => { setCreating(false); }} onCreated={(next) => { setCreating(false); setMade(next); }} />
      <ShownKey made={made} onClose={() => { setMade(null); }} />
    </Groups>
  );
}
