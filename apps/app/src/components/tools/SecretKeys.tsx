import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Switch } from '@stage-labs/kit/react-native/switch';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { changeVault, fetchVault, type Vault, type VaultSecret } from '@metro-labs/client/api/vault';
import { whenLabel } from '@metro-labs/client/api/when';
import { Icon } from '../Icon.js';
import { Loading } from '../Loading.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { StateBlock } from '../ui/StateBlock.js';
import { KeyModal, RecentModal, useDeleteKey } from './KeyModals.js';
import { useAgentName } from '../../lib/agent-hooks.js';
import { queryError, useBoxQuery } from '../../lib/queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { keyLastUsed } from '../../lib/tools-view.js';

const PLUS = 22;
const ON_NOTE = 'All web traffic goes through Metro. Other traffic, like git over SSH, is blocked.';
const OFF_NOTE = 'Off: the agent cannot use the keys below.';

function useVault(): { vault: Vault | undefined; error: unknown; set: (v: Vault) => void } {
  const client = useQueryClient();
  const query = useBoxQuery('vault', fetchVault, { refetchInterval: 10_000 });
  return {
    vault: query.data,
    error: query.error,
    set: (v) => {
      client.setQueriesData({ predicate: (q) => q.queryKey.includes('vault') }, v);
    },
  };
}

function protectLine(vault: Vault, busy: boolean, error: string | null): { text: string; bad: boolean } {
  if (error !== null) return { text: error, bad: true };
  if (vault.problem !== null) return { text: vault.problem, bad: true };
  if (busy) return { text: 'Working…', bad: false };
  if (vault.enabled && !vault.running) return { text: 'On, but not running yet.', bad: false };
  return { text: vault.enabled ? ON_NOTE : OFF_NOTE, bad: false };
}

function ProtectRow({ vault, onChanged }: { vault: Vault; onChanged: (v: Vault) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flip = (on: boolean): void => {
    setBusy(true);
    setError(null);
    changeVault({ action: on ? 'enable' : 'disable' })
      .then(onChanged)
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not change the protection.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const line = protectLine(vault, busy, error);
  return (
    <Item
      title="Protect secret keys"
      subtitle={line.text}
      subtitleTone={line.bad ? 'danger' : 'secondary'}
      detail={vault.enabled && vault.browsers !== null ? vault.browsers : undefined}
      trailing={<Switch checked={vault.enabled} dark={dark} disabled={busy} name="Protect secret keys" onChange={flip} />}
    />
  );
}

function KeyRow({ vault, secret, onOpen }: { vault: Vault; secret: VaultSecret; onOpen: () => void }): ReactNode {
  const technical = useTechnicalDetails();
  const used = keyLastUsed(vault, secret.id);
  return (
    <Item
      title={secret.name}
      subtitle={secret.hosts.join(', ')}
      detail={technical ? secret.env : undefined}
      value={vault.enabled ? (used === null ? 'Not used lately' : whenLabel(used)) : undefined}
      onPress={onOpen}
    />
  );
}

function AddRow({ onPress }: { onPress: () => void }): ReactNode {
  const palette = useKitPalette();
  return <Item title="Add a key" leading={<Icon name="plus" size={PLUS} color={palette.link} />} chevron={false} onPress={onPress} />;
}

function Keys({ vault, set }: { vault: Vault; set: (v: Vault) => void }): ReactNode {
  const [form, setForm] = useState<VaultSecret | 'new' | null>(null);
  const [recent, setRecent] = useState(false);
  const removal = useDeleteKey(set);
  const saved = (v: Vault): void => {
    set(v);
    setForm(null);
  };
  return (
    <>
      <ProtectRow vault={vault} onChanged={set} />
      {vault.secrets.map((s) => <KeyRow key={s.id} vault={vault} secret={s} onOpen={() => { setForm(s); }} />)}
      <AddRow onPress={() => { setForm('new'); }} />
      {vault.enabled && vault.recent.length > 0 ? <Item title="Recent use" subtitle="What went out through Metro lately" onPress={() => { setRecent(true); }} /> : null}
      {form === null ? null : (
        <KeyModal editing={form} onSaved={saved} onClose={() => { setForm(null); }} onDelete={(secret) => { setForm(null); removal.ask(secret); }} />
      )}
      {recent ? <RecentModal vault={vault} onClose={() => { setRecent(false); }} /> : null}
      {removal.dialog}
    </>
  );
}

function Contents(): ReactNode {
  const { vault, error, set } = useVault();
  if (error !== null && error !== undefined) return <StateBlock icon="exclamationCircle" danger title="Could not read the keys" text={queryError(error, 'Try again in a moment.')} />;
  if (vault === undefined) return <Loading />;
  if (!vault.available) return <StateBlock icon="key" title="Not on this server" text="Secret keys need a Linux server where the agent runs as its own user." />;
  return <Keys vault={vault} set={set} />;
}

export function SecretKeys(): ReactNode {
  const name = useAgentName();
  return (
    <Group label="Secret keys" note={`${name} sees a stand-in. The real key goes only to its website.`}>
      <Contents />
    </Group>
  );
}
