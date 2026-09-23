import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button, Input, Text } from './ui.js';
import { GROW } from '../theme.js';
import { accountName, claimAccountName } from '../api/attach.js';
import { boxKey, queryError, useBoxQuery } from '../api/queries.js';

const FIELD_WIDTH = 420;
const SUFFIX = '.stage.base.eth';
const NO_NAME = 'No name yet, so no profile on Stage. 6 to 32 lowercase letters, digits and single hyphens, and it cannot be changed once claimed.';
const OLD_ACCOUNT = 'This account was attached before names existed. Attach XMTP again to get one that can hold a name.';

const nameKey = (station: string, accountId: string): string[] => boxKey(['account-name', station, accountId]);

function ClaimName({ agentId, station, accountId }: { agentId: string; station: string; accountId: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claim = (): void => {
    setBusy(true);
    setError(null);
    claimAccountName(agentId, station, accountId, label.trim().toLowerCase())
      .then((named) => {
        client.setQueryData(nameKey(station, accountId), named);
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not claim that name.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Col gap={8} maxWidth={FIELD_WIDTH}>
      <Text size="sm" role="secondary">
        {NO_NAME}
      </Text>
      <Row gap={8} align="center">
        <Input name="stage-name" value={label} placeholder="lisa-mci" dark={dark} onChangeText={setLabel} style={GROW} />
        <Text size="sm" role="secondary">
          {SUFFIX}
        </Text>
      </Row>
      <Row>
        <Button size="sm" dark={dark} label={busy ? 'Claiming…' : 'Claim'} loading={busy} disabled={busy || label.trim().length < 6} onPress={claim} />
      </Row>
      {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
    </Col>
  );
}

export function StationName({ agentId, station, accountId }: { agentId: string; station: string; accountId: string }): ReactNode {
  const { data, error } = useBoxQuery(['account-name', station, accountId], () => accountName(agentId, station, accountId), { staleTime: 60_000 });
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, 'Could not read the name.')}</Text>;
  if (data === undefined) return null;
  if (data.name !== null) return <Text size="sm">{data.name}</Text>;
  if (!data.canClaim)
    return (
      <Text size="sm" role="secondary">
        {OLD_ACCOUNT}
      </Text>
    );
  return <ClaimName agentId={agentId} station={station} accountId={accountId} />;
}
