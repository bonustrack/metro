import { type ReactNode, useState } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Button } from '@stage-labs/kit/react-native/button';
import { FormField } from './FormField.js';
import { Text } from '@stage-labs/kit/react-native/text';
import { MetroLogo } from './MetroLogo.js';
import { PageTitle } from './PageTitle.js';
import { createOrganization } from '@metro-labs/client/api/auth';
import { allSides } from './ui/edges.js';
import { PageScroll } from './PageScroll.js';

const CARD_WIDTH = 400;
const NAME_MIN = 2;
const NAME_MAX = 64;
const WHAT = 'Your agents belong to an organization. Name it now and invite people later.';

export function OrganizationSetup({ onDone, onLock }: { onDone: () => void; onLock: () => void }): ReactNode {
  const palette = useKitPalette();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim().length >= NAME_MIN && name.trim().length <= NAME_MAX;
  const create = (): void => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    createOrganization(name.trim())
      .then(() => {
        onDone();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not create the organization.');
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <PageScroll>
    <Row justify="center" align="center" weight={1} padding={24}>
      <Column gap={20} width="100%" maxWidth={CARD_WIDTH} padding={24} radius={BLOCK_RADIUS_DEFAULT} border={allSides(palette.border)}>
        <Row justify="center">
          <MetroLogo size={48} color={palette.link} />
        </Row>
        <Row justify="center">
          <PageTitle>Name your organization</PageTitle>
        </Row>
        <Text size="md" color="secondary">
          {WHAT}
        </Text>
        <FormField label="Organization name" name="organization" value={name} placeholder="Stage Labs" disabled={busy} onChangeText={setName} />
        <Row gap={10} align="center" wrap>
          <Button size="lg" color="primary" label={busy ? 'Creating…' : 'Create'} loading={busy} disabled={busy || !valid} onPress={create} />
          <Button color="secondary" label="Sign out" disabled={busy} onPress={onLock} />
        </Row>
        {error === null ? null : (
          <Text size="md" color="danger">
            {error}
          </Text>
        )}
      </Column>
    </Row>
    </PageScroll>
  );
}
