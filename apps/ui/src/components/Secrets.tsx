import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Icon } from '@stage-labs/kit/react-native/icon';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button, Text } from './ui.js';
import { DeleteMenu } from './DeleteMenu.js';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
import { Loading } from './Loading.js';
import { PageTitle } from './PageTitle.js';
import { Choice } from './Choice.js';
import { EmptyCard, SettingsGroup, SettingsSection } from './SettingsSection.js';
import { SecretForm } from './SecretForm.js';
import { changeVault, fetchVault, type Vault, type VaultSecret } from '../api/vault.js';
import { queryError, useBoxQuery } from '../api/queries.js';
import { whenLabel } from '../api/when.js';
import { useDocumentTitle } from '../title.js';

const INTRO = 'Keys your agent can use without ever seeing them. The agent only holds a stand-in; Metro puts the real key in when the agent talks to that key’s website.';
const ON_NOTE = 'All of the agent’s web traffic goes through Metro. Other traffic, like git over SSH, is blocked.';

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

function Switch({ vault, onChanged }: { vault: Vault; onChanged: (v: Vault) => void }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flip = (): void => {
    setBusy(true);
    setError(null);
    changeVault({ action: vault.enabled ? 'disable' : 'enable' })
      .then(onChanged)
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not change the vault.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const note = busy ? 'Working…' : vault.enabled && !vault.running ? 'On, but not running yet.' : ON_NOTE;
  return (
    <SettingsSection title="Protect secrets" note={note}>
      <Choice
        label="Protect secrets"
        value={vault.enabled ? 'on' : 'off'}
        options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
        disabled={busy}
        onChange={flip}
      />
      {vault.problem === null ? null : <Text size="sm" role="danger">{vault.problem}</Text>}
      {vault.enabled && vault.browsers !== null ? <Text size="sm" role="secondary">{vault.browsers}</Text> : null}
      {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
    </SettingsSection>
  );
}

function SecretRow({ secret, onEdit, onRemoved }: { secret: VaultSecret; onEdit: () => void; onRemoved: (v: Vault) => void }): ReactNode {
  const palette = useKitPalette();
  return (
    <ListRow
      title={secret.name}
      detail={`${secret.env} · ${secret.hosts.join(', ')}`}
      icon={<Icon name="key" size={LIST_ICON_SIZE} color={palette.sub} />}
      onOpen={onEdit}
      trailing={
        <DeleteMenu
          label={`Actions for ${secret.name}`}
          action="Delete secret"
          title="Delete this secret?"
          lines={[`The value of ${secret.env} is removed from this machine. Anything the agent sends with the placeholder stops working.`]}
          failure="Could not delete the secret."
          run={async () => {
            onRemoved(await changeVault({ action: 'remove', id: secret.id }));
          }}
        />
      }
    />
  );
}

function Recent({ vault }: { vault: Vault }): ReactNode {
  if (!vault.enabled || vault.recent.length === 0) return null;
  const envOf = (id: string): string => vault.secrets.find((s) => s.id === id)?.env ?? 'a deleted secret';
  return (
    <SettingsGroup title="Recent use">
      <div className="settings-pad">
      <Col gap={4}>
        {vault.recent.slice(0, 40).map((r, at) => (
          <Text key={`${String(at)}:${r.at}`} size="sm" role={r.swapped.length > 0 ? 'default' : 'secondary'} numberOfLines={1}>
            {`${whenLabel(r.at)} · ${r.method} ${r.host}${r.path} · ${r.status === null ? '…' : String(r.status)}${r.swapped.length > 0 ? ` · used ${r.swapped.map(envOf).join(', ')}` : ''}`}
          </Text>
        ))}
      </Col>
      </div>
    </SettingsGroup>
  );
}

function SecretList({ vault, set }: { vault: Vault; set: (v: Vault) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [form, setForm] = useState<VaultSecret | 'new' | null>(null);
  const saved = (v: Vault): void => {
    set(v);
    setForm(null);
  };
  return (
    <SettingsGroup
      title="Secrets"
      action={form === null ? <Button size="sm" color="secondary" dark={dark} label="Add secret" onPress={() => { setForm('new'); }} /> : undefined}
    >
      {form === null ? null : (
        <div className="settings-pad">
          <SecretForm key={form === 'new' ? 'new' : form.id} editing={form === 'new' ? null : form} onSaved={saved} onCancel={() => { setForm(null); }} />
        </div>
      )}
      {vault.secrets.length === 0 && form === null ? (
        <div className="settings-pad">
          <Text size="sm" role="secondary">No secret yet. Add one, then turn protection on.</Text>
        </div>
      ) : null}
      {vault.secrets.map((s) => (
        <SecretRow key={s.id} secret={s} onEdit={() => { setForm(s); }} onRemoved={set} />
      ))}
    </SettingsGroup>
  );
}

function SecretsBody(): ReactNode {
  const { vault, error, set } = useVault();
  if (error !== null && error !== undefined) return <Text size="sm" role="danger">{queryError(error, 'Could not read the vault.')}</Text>;
  if (vault === undefined) return <Loading />;
  if (!vault.available) return <EmptyCard text="Secrets need a Linux server where the agent runs as its own user." />;
  return (
    <Col gap={32}>
      <SettingsGroup>
        <Switch vault={vault} onChanged={set} />
      </SettingsGroup>
      <SecretList vault={vault} set={set} />
      <Recent vault={vault} />
    </Col>
  );
}

export function Secrets(): ReactNode {
  useDocumentTitle('Secrets');
  return (
    <Col gap={32}>
      <PageTitle>Secrets</PageTitle>
      <Text size="sm" role="secondary">{INTRO}</Text>
      <SecretsBody />
    </Col>
  );
}
