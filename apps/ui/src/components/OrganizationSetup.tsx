import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Text, Button, Input } from './ui.js';
import { MetroLogo } from './MetroLogo.js';
import { PageTitle } from './PageTitle.js';
import { createOrganization } from '../api/auth.js';

const CARD_WIDTH = 400;
const NAME_MIN = 2;
const NAME_MAX = 64;
const WHAT = 'Your agents belong to an organization. Name it, and invite others to it later from the Members page.';

export function OrganizationSetup({ onDone, onLock }: { onDone: () => void; onLock: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const palette = useKitPalette();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const side = { width: 1, color: palette.border };
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
    <Row justify="center" align="center" flex={1} padding={24}>
      <Col gap={20} width="100%" maxWidth={CARD_WIDTH} padding={24} radius={BLOCK_RADIUS_DEFAULT} border={{ top: side, right: side, bottom: side, left: side }}>
        <Row justify="center">
          <MetroLogo size={48} color={palette.link} />
        </Row>
        <Row justify="center">
          <PageTitle>Name your organization</PageTitle>
        </Row>
        <Text size="sm" role="secondary">
          {WHAT}
        </Text>
        <Input name="organization" value={name} dark={dark} placeholder="Stage Labs" disabled={busy} onChangeText={setName} />
        <Row gap={10} align="center" wrap>
          <Button color="primary" dark={dark} label={busy ? 'Creating…' : 'Create'} loading={busy} disabled={busy || !valid} onPress={create} />
          <Button color="secondary" dark={dark} label="Sign out" disabled={busy} onPress={onLock} />
        </Row>
        {error === null ? null : (
          <Text size="sm" role="danger">
            {error}
          </Text>
        )}
      </Col>
    </Row>
  );
}
