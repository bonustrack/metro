import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Icon } from '@stage-labs/kit/react-native/icon';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button, Text } from './ui.js';
import { DeleteMenu } from './DeleteMenu.js';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
import { Loading } from './Loading.js';
import { PageTitle } from './PageTitle.js';
import { SecretForm } from './SecretForm.js';
import { changeVault, fetchVault, VAULT_SINCE, type Vault, type VaultSecret } from '../api/vault.js';
import { queryError, useBoxQuery, useModeQuery } from '../api/queries.js';
import { olderThan } from '../api/version.js';
import { whenLabel } from '../api/when.js';
import { useDocumentTitle } from '../title.js';

const INTRO =
  "Keys the agent can use but never read. The agent only gets a placeholder named like the variable, for example OPENAI_API_KEY=OPENAI_API_KEY. When it sends that placeholder to one of the key's websites, Metro puts the real value in on the way out. Sent anywhere else, it stays a useless word.";
const ON_NOTE =
  "While the vault is on, all of the agent's internet traffic goes through Metro, and the agent cannot connect around it. Web traffic works as before; other kinds (git over SSH, database ports) are blocked.";

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
  const dark = useKitScheme() === 'dark';
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
  const state = !vault.enabled ? 'The vault is off.' : vault.running ? 'The vault is on.' : 'The vault is on but not running.';
  return (
    <Col gap={8}>
      <Row gap={12} align="center" wrap>
        <Text size="md" weight="semibold">{state}</Text>
        <Button size="sm" color={vault.enabled ? 'secondary' : 'primary'} dark={dark} disabled={busy} label={busy ? 'Working…' : vault.enabled ? 'Turn off' : 'Turn on'} onPress={flip} />
      </Row>
      <Text size="sm" role="secondary">{ON_NOTE}</Text>
      {vault.problem === null ? null : <Text size="sm" role="danger">{vault.problem}</Text>}
      {vault.enabled && vault.browsers !== null ? <Text size="sm" role="secondary">{vault.browsers}</Text> : null}
      {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
    </Col>
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
    <Col gap={8}>
      <Text size="lg" weight="semibold">Recent requests</Text>
      <Col gap={4}>
        {vault.recent.slice(0, 40).map((r, at) => (
          <Text key={`${String(at)}:${r.at}`} size="sm" role={r.swapped.length > 0 ? 'default' : 'secondary'} numberOfLines={1}>
            {`${whenLabel(r.at)} · ${r.method} ${r.host}${r.path} · ${r.status === null ? '…' : String(r.status)}${r.swapped.length > 0 ? ` · used ${r.swapped.map(envOf).join(', ')}` : ''}`}
          </Text>
        ))}
      </Col>
    </Col>
  );
}

function SecretsBody(): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { vault, error, set } = useVault();
  const [form, setForm] = useState<VaultSecret | 'new' | null>(null);
  if (error !== null && error !== undefined) return <Text size="sm" role="danger">{queryError(error, 'Could not read the vault.')}</Text>;
  if (vault === undefined) return <Loading />;
  if (!vault.available) return <Text size="sm" role="secondary">The vault needs a Linux box where Claude Code runs as its own user.</Text>;
  const saved = (v: Vault): void => {
    set(v);
    setForm(null);
  };
  return (
    <Col gap={20}>
      <Switch vault={vault} onChanged={set} />
      <Col>
        {vault.secrets.length === 0 ? <Text size="sm" role="secondary">No secret yet.</Text> : null}
        {vault.secrets.map((s) => (
          <SecretRow key={s.id} secret={s} onEdit={() => { setForm(s); }} onRemoved={set} />
        ))}
      </Col>
      {form === null ? (
        <Button size="sm" dark={dark} label="Add a secret" onPress={() => { setForm('new'); }} />
      ) : (
        <SecretForm key={form === 'new' ? 'new' : form.id} editing={form === 'new' ? null : form} onSaved={saved} onCancel={() => { setForm(null); }} />
      )}
      <Recent vault={vault} />
    </Col>
  );
}

export function Secrets(): ReactNode {
  useDocumentTitle('Secrets');
  const mode = useModeQuery();
  if (mode.data === undefined) return <Loading />;
  return (
    <Col gap={16}>
      <PageTitle>Secrets</PageTitle>
      <Text size="sm" role="secondary">{INTRO}</Text>
      {olderThan(mode.data.version, VAULT_SINCE) ? <Text size="sm" role="secondary">{`Needs metro ${VAULT_SINCE}. Update first, from the Server page.`}</Text> : <SecretsBody />}
    </Col>
  );
}
