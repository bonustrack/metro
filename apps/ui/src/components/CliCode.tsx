import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { CopyBlock } from './CopyBlock';
import { mintCliCode } from '../api/client';

interface CliCodeProps {
  token: string;
}

export function CliCode({ token }: CliCodeProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    mintCliCode(token)
      .then(setCode)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not create a code.');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Col gap={12}>
      <Col gap={2}>
        <Text weight="semibold">Command line</Text>
        <Text size="sm" role="secondary">
          Run metro login on any machine, then paste this code. It needs no browser
          there, so it works over SSH. It lasts ten minutes and can be used once.
        </Text>
      </Col>
      {code === null ? null : <CopyBlock label="Code" value={code} />}
      {error === null ? null : (
        <Text size="sm" role="danger">
          {error}
        </Text>
      )}
      <Row gap={8} wrap>
        <Button
          size="sm"
          dark={dark}
          color={code === null ? 'primary' : 'secondary'}
          onPress={generate}
          loading={busy}
          disabled={busy}
          label={code === null ? 'Create code' : 'Create another'}
        />
      </Row>
    </Col>
  );
}
