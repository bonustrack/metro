import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { activeAccount, type Account } from '../auth/account.js';
import { refreshAccount } from '../api/auth.js';
import { renameOrganization } from '../api/organization.js';
import { queryError } from '../api/queries.js';

const NAME_MIN = 2;
const NAME_MAX = 64;

interface Rename {
  name: string;
  setName: (v: string) => void;
  busy: boolean;
  error: string | null;
  saved: boolean;
  ready: boolean;
  save: () => void;
}

function useRename(account: Account): Rename {
  const client = useQueryClient();
  const [name, setName] = useState(account.organizationName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const trimmed = name.trim();
  const ready = trimmed.length >= NAME_MIN && trimmed.length <= NAME_MAX && trimmed !== (account.organizationName ?? '');
  const save = (): void => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    renameOrganization(trimmed)
      .then(() => refreshAccount())
      .then(async () => {
        setSaved(true);
        await client.invalidateQueries({ queryKey: ['organization'] });
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not rename the organization.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { name, setName, busy, error, saved, ready, save };
}

function Note({ rename }: { rename: Rename }): ReactNode {
  if (rename.error !== null) return <Text size="sm" role="danger">{rename.error}</Text>;
  if (rename.saved) return <Text size="sm" role="secondary">Saved.</Text>;
  return null;
}

function Block({ account }: { account: Account }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const rename = useRename(account);
  const admin = account.role === 'admin';
  return (
    <Col gap={12}>
      <Col gap={2}>
        <Text weight="semibold">Organization</Text>
        <Text size="sm" role="secondary">
          {admin ? 'The name every member sees, on this page and in the invitations Metro sends.' : 'Only an admin can rename the organization.'}
        </Text>
      </Col>
      <Row gap={8} align="center" wrap>
        <Input name="organization" value={rename.name} dark={dark} disabled={rename.busy || !admin} onChangeText={rename.setName} />
        {admin ? <Button color="primary" dark={dark} label={rename.busy ? 'Saving…' : 'Save'} loading={rename.busy} disabled={rename.busy || !rename.ready} onPress={rename.save} /> : null}
      </Row>
      <Note rename={rename} />
    </Col>
  );
}

export function OrganizationSettings(): ReactNode {
  const account = activeAccount();
  const organization = account?.organization ?? null;
  if (account === null || organization === null) return null;
  return <Block account={account} />;
}
