import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';

interface DetachAccountProps {
  station: string;
  accountId: string;
  onDetach: (station: string, accountId: string) => Promise<void>;
}

export function DetachAccount({
  station,
  accountId,
  onDetach,
}: DetachAccountProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    onDetach(station, accountId).catch((err: unknown) => {
      setError(
        err instanceof Error ? err.message : 'Could not detach the account.',
      );
      setBusy(false);
      setConfirming(false);
    });
  };

  return (
    <Col gap={8} align="start">
      {confirming ? (
        <Col gap={8}>
          <Text size="sm" role="danger">
            Detach this account? Metro forgets its credentials and stops relaying
            it. This cannot be undone.
          </Text>
          <Row gap={8} wrap>
            <Button
              size="sm"
              color="danger"
              dark={dark}
              onPress={remove}
              loading={busy}
              disabled={busy}
              label="Yes, detach it"
            />
            <Button
              size="sm"
              color="secondary"
              dark={dark}
              disabled={busy}
              onPress={() => {
                setConfirming(false);
              }}
              label="Cancel"
            />
          </Row>
        </Col>
      ) : (
        <Button
          size="sm"
          color="danger"
          variant="soft"
          dark={dark}
          onPress={() => {
            setConfirming(true);
          }}
          label="Detach"
        />
      )}
      {error !== null ? (
        <Text size="sm" role="danger">
          {error}
        </Text>
      ) : null}
    </Col>
  );
}
