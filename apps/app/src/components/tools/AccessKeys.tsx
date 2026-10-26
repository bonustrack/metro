import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Column } from '@stage-labs/kit/react-native/column';
import { CheckBox } from '@stage-labs/kit/react-native/check-box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { claudeCommand, createAgentKey, GATEWAY_URL, gatewaySnippet, KEY_SCOPES, MCP_URL, revokeAgentKey, setAgentKeyScopes, type AgentKey, type KeyScope, type NewAgentKey } from '@metro-labs/client/api/agent-keys';
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
const NOTE = 'A key lets Claude Code, any MCP client or your own service use this agent\'s connectors, its models, or both. Anyone with the key can use them, so keep it like a password.';

const SCOPE_WORDS: Record<KeyScope, { title: string; note: string }> = {
  connectors: { title: 'Connectors', note: 'Its connectors, through mcp.metro.box' },
  gateway: { title: 'Gateway', note: 'Its models, through gateway.metro.box' },
};

const scopesLine = (scopes: KeyScope[]): string => scopes.map((scope) => SCOPE_WORDS[scope].title).join(' · ');

function ScopePicker({ value, onChange, disabled }: { value: KeyScope[]; onChange: (next: KeyScope[]) => void; disabled: boolean }): ReactNode {
  const flip = (scope: KeyScope): void => {
    onChange(KEY_SCOPES.filter((one) => (one === scope ? !value.includes(one) : value.includes(one))));
  };
  return (
    <Column>
      {KEY_SCOPES.map((scope) => (
        <Item key={scope} title={SCOPE_WORDS[scope].title} subtitle={SCOPE_WORDS[scope].note} chevron={false}
          trailing={<CheckBox displayStyle="switch" name={SCOPE_WORDS[scope].title} value={value.includes(scope)} disabled={disabled} onChange={() => { flip(scope); }} />} />
      ))}
    </Column>
  );
}

const iso = (at: number): string => new Date(at).toISOString();

function keyLine(key: AgentKey, now: number): string {
  if (key.revokedAt !== null) return `Revoked ${whenLabel(iso(key.revokedAt), now)}`;
  const used = key.lastUsedAt === null ? 'never used' : `last used ${whenLabel(iso(key.lastUsedAt), now)}`;
  return `${scopesLine(key.scopes)} · created ${whenLabel(iso(key.createdAt), now)} · ${used}`;
}

function KeyRow({ agent, item, admin, now }: { agent: string; item: AgentKey; admin: boolean; now: number }): ReactNode {
  const palette = useKitPalette();
  const client = useQueryClient();
  const revoking = useConfirm(async () => {
    await revokeAgentKey(agent, item.id);
    await refreshAgentKeys(client, agent);
  }, 'Could not revoke the key.');
  const live = item.revokedAt === null;
  const [changing, setChanging] = useState(false);
  return (
    <>
      <Item
        title={item.label}
        subtitle={keyLine(item, now)}
        subtitleTone={live ? 'secondary' : 'danger'}
        leading={<Icon name="key" size={ICON_SIZE.lg} color={live ? palette.text : palette.sub} />}
        chevron={false}
        trailing={admin && live ? <KebabMenu ghost label={`Actions for ${item.label}`} items={[{ label: 'Change access', onSelect: () => { setChanging(true); } }, { label: 'Revoke', danger: true, onSelect: revoking.show }]} /> : undefined}
      />
      <ConfirmDialog confirming={revoking} title={`Revoke ${item.label}?`} lines={['Anything that uses this key loses its access at once. This cannot be undone.']} action="Revoke key" name={item.label} />
      <ChangeScopes key={changing ? 'open' : 'closed'} agent={agent} item={item} open={changing} onClose={() => { setChanging(false); }} />
    </>
  );
}

function ChangeScopes({ agent, item, open, onClose }: { agent: string; item: AgentKey; open: boolean; onClose: () => void }): ReactNode {
  const client = useQueryClient();
  const [scopes, setScopes] = useState<KeyScope[]>(item.scopes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = (): void => {
    if (!busy) onClose();
  };
  const submit = (): void => {
    if (scopes.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setAgentKeyScopes(agent, item.id, scopes)
      .then(async () => {
        await refreshAgentKeys(client, agent);
        onClose();
      })
      .catch((err: unknown) => { setError(queryError(err, 'Could not change the key.')); })
      .finally(() => { setBusy(false); });
  };
  return (
    <Modal title={`What ${item.label} can use`} open={open} onClose={close}>
      <Column gap={20}>
        <ModalText>The change applies to the next request made with this key.</ModalText>
        <ScopePicker value={scopes} onChange={setScopes} disabled={busy} />
        <Actions error={error} cancel={{ onPress: close, disabled: busy }} main={{ label: 'Save', busy, disabled: scopes.length === 0, onPress: submit }} />
      </Column>
    </Modal>
  );
}

function CreateKey({ agent, open, onClose, onCreated }: { agent: string; open: boolean; onClose: () => void; onCreated: (made: NewAgentKey) => void }): ReactNode {
  const client = useQueryClient();
  const [label, setLabel] = useState('Claude Code');
  const [scopes, setScopes] = useState<KeyScope[]>(['connectors']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = label.trim() !== '' && label.trim().length <= LABEL_MAX && scopes.length > 0;
  const close = (): void => {
    if (busy) return;
    setError(null);
    onClose();
  };
  const submit = (): void => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    createAgentKey(agent, label, scopes)
      .then(async (made) => {
        await refreshAgentKeys(client, agent);
        onCreated(made);
      })
      .catch((err: unknown) => { setError(queryError(err, 'Could not create the key.')); })
      .finally(() => { setBusy(false); });
  };
  return (
    <Modal title="Create an access key" open={open} onClose={close}>
      <Column gap={20}>
        <ModalText>Name it after where you use it, like your laptop or a tool.</ModalText>
        <FormField label="Name" name="key-label" value={label} placeholder="Claude Code" disabled={busy} onChangeText={setLabel} onSubmit={submit} style={GROW} />
        <ScopePicker value={scopes} onChange={setScopes} disabled={busy} />
        <Actions error={error} cancel={{ onPress: close, disabled: busy }} main={{ label: 'Create key', busy, disabled: !ready, onPress: submit }} />
      </Column>
    </Modal>
  );
}

function ShownKey({ made, onClose }: { made: NewAgentKey | null; onClose: () => void }): ReactNode {
  if (made === null) return null;
  return (
    <Modal title={`${made.key.label} key`} open onClose={onClose}>
      <Column gap={20}>
        <ModalText>Copy it now. Metro shows it only once.</ModalText>
        <CopyBlock label="Key" value={made.secret} />
        {made.key.scopes.includes('connectors') ? (
          <>
            <CopyBlock label="Add its connectors to Claude Code" value={claudeCommand(made.secret)} />
            <Text size="xs" color="secondary">{`Any MCP client: URL ${MCP_URL}, header Authorization: Bearer <key>`}</Text>
          </>
        ) : null}
        {made.key.scopes.includes('gateway') ? (
          <>
            <CopyBlock label="Use its models from your code" value={gatewaySnippet(made.secret)} />
            <Text size="xs" color="secondary">{'Model "metro" uses the agent\'s main models, "metro-workers" its worker models.'}</Text>
          </>
        ) : null}
        <Actions main={{ label: 'Done', onPress: onClose }} />
      </Column>
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
    <>
      <Group label="Connectors" note="For a key with Connectors. Send the key as a bearer token. Every call shows in Activity.">
        <Column gap={16} padding={{ y: 14 }}>
          <CopyBlock label="MCP server" value={MCP_URL} />
          <CopyBlock label="Header" value="Authorization: Bearer <key>" />
        </Column>
      </Group>
      <Group label="Gateway" note={'For a key with Gateway. It speaks the Anthropic Messages API: any Anthropic SDK works with this base URL. Model "metro" or "metro-workers".'}>
        <Column gap={16} padding={{ y: 14 }}>
          <CopyBlock label="Base URL" value={GATEWAY_URL} />
          <CopyBlock label="Header" value="x-api-key: <key>" />
        </Column>
      </Group>
    </>
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
