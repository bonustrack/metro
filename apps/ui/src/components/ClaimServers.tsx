import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Text, Button } from './ui.js';
import { WalletList } from './Login.js';
import { activeAccount } from '../auth/account.js';
import { activeIdentity } from '../auth/identity.js';
import { claimServers } from '../api/servers.js';
import { queryError, refreshServers } from '../api/queries.js';

const WHY =
  'Servers added before Google sign-in are listed under your wallet. Move them to your organization once, and they show up here for every member.';

export function ClaimServers(): ReactNode {
  const dark = useKitScheme() === 'dark';
  const palette = useKitPalette();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<number | null>(null);
  const [wallet, setWallet] = useState(activeIdentity() !== null);
  if (activeAccount()?.organization === null) return null;
  const side = { width: 1, color: palette.border };
  const claim = (): void => {
    const identity = activeIdentity();
    if (identity === null) return;
    setBusy(true);
    setError(null);
    claimServers(identity)
      .then(async (count) => {
        setMoved(count);
        await refreshServers(client);
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not move the servers.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Col gap={10} padding={16} radius={BLOCK_RADIUS_DEFAULT} border={{ top: side, right: side, bottom: side, left: side }}>
      <Text size="md" weight="semibold">Bring my servers over</Text>
      <Text size="sm" role="secondary">{WHY}</Text>
      {wallet ? (
        <Row gap={10} align="center" wrap>
          <Button color="primary" dark={dark} label={busy ? 'Moving…' : 'Move my servers to my organization'} loading={busy} disabled={busy} onPress={claim} />
          {moved === null ? null : <Text size="sm" role="secondary">{`${String(moved)} moved.`}</Text>}
        </Row>
      ) : (
        <Col gap={8}>
          <Text size="sm" role="secondary">Connect the wallet they were added with, to sign the move.</Text>
          <WalletList
            onSignedIn={() => {
              setWallet(true);
            }}
          />
        </Col>
      )}
      {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
    </Col>
  );
}
