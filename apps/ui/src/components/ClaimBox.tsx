import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Text, Button } from './ui.js';
import { WalletList } from './Login.js';
import { activeAccount } from '../auth/account.js';
import { activeIdentity } from '../auth/identity.js';
import { claimBox, isOrganizationId } from '../api/owner.js';
import { queryError, useModeQuery } from '../api/queries.js';
import { olderThan } from '../api/version.js';

export const CLAIM_SINCE = '0.1.0-beta.136';
const WHY =
  'This box still belongs to your wallet. Hand it to your organization so your Google sign-in opens it, and every member you invite can use it. The wallet is refused on this box after that.';

function ClaimAction({ organization, onDone }: { organization: string; onDone: () => Promise<void> }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wallet, setWallet] = useState(activeIdentity() !== null);
  const claim = (): void => {
    setBusy(true);
    setError(null);
    claimBox(organization)
      .then(onDone)
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not claim this box.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  if (!wallet)
    return (
      <Col gap={8}>
        <Text size="sm" role="secondary">Connect the wallet that owns this box once, to sign the hand-over.</Text>
        <WalletList
          onSignedIn={() => {
            setWallet(true);
          }}
        />
      </Col>
    );
  return (
    <Col gap={8}>
      <Row gap={10} align="center" wrap>
        <Button color="primary" dark={dark} label={busy ? 'Claiming…' : 'Claim for my organization'} loading={busy} disabled={busy} onPress={claim} />
      </Row>
      {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
    </Col>
  );
}

function claimable(owner: string | null, organization: string | null): organization is string {
  return isOrganizationId(organization) && owner !== null && !isOrganizationId(owner);
}

export function ClaimBox(): ReactNode {
  const palette = useKitPalette();
  const client = useQueryClient();
  const mode = useModeQuery();
  const organization = activeAccount()?.organization ?? null;
  if (!claimable(mode.data?.owner ?? null, organization)) return null;
  const old = olderThan(mode.data?.version ?? null, CLAIM_SINCE);
  const side = { width: 1, color: palette.border };
  return (
    <Col gap={10} padding={16} radius={BLOCK_RADIUS_DEFAULT} border={{ top: side, right: side, bottom: side, left: side }}>
      <Text size="md" weight="semibold">Claim this box</Text>
      <Text size="sm" role="secondary">{WHY}</Text>
      {old ? (
        <Text size="sm" role="secondary">{`Claiming needs metro ${CLAIM_SINCE} on this box. Update it from the Server page first.`}</Text>
      ) : (
        <ClaimAction organization={organization} onDone={() => client.invalidateQueries()} />
      )}
    </Col>
  );
}
