import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import {
  useKitPalette,
  useKitScheme,
} from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Text, Button } from './ui';
import { MetroLogo } from './MetroLogo';
import { PageTitle } from './PageTitle';
import { CopyBlock } from './CopyBlock';
import { mintRuntimeCode } from '../api/client';
import { queryError } from '../api/queries';
import { useDocumentTitle } from '../title';

const CARD_WIDTH = 460;

function Card({ children }: { children: ReactNode }): ReactNode {
  const palette = useKitPalette();
  const side = { width: 1, color: palette.border };
  return (
    <Row justify="center" align="center" flex={1} padding={24}>
      <Col
        gap={24}
        width="100%"
        maxWidth={CARD_WIDTH}
        padding={24}
        radius={BLOCK_RADIUS_DEFAULT}
        border={{ top: side, right: side, bottom: side, left: side }}
      >
        <Row justify="center">
          <MetroLogo size={48} color={palette.link} />
        </Row>
        <Row justify="center">
          <PageTitle>Authorize a machine</PageTitle>
        </Row>
        {children}
      </Col>
    </Row>
  );
}

export function AuthorizeMachine({
  token,
  id,
}: {
  token: string;
  id: string;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useDocumentTitle('Authorize a machine');

  const mint = (): void => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    mintRuntimeCode(token, id)
      .then(setCode)
      .catch((err: unknown) => {
        setFailed(queryError(err, 'Could not create a pairing code.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Card>
      <Col gap={14}>
        <Text size="sm" role="secondary">
          Paste this code into the terminal running metro start. That machine
          runs this agent&apos;s stations, so their messages never pass through
          Metro.
        </Text>
        <CopyBlock label="on your machine" value={`metro start ${id}`} />
        {code === null ? null : (
          <CopyBlock label="pairing code" value={code} secret hide={code} />
        )}
        {failed === null ? null : (
          <Text size="sm" role="danger">
            {failed}
          </Text>
        )}
        <Button
          block
          size="md"
          color="primary"
          dark={dark}
          loading={busy}
          label={code === null ? 'Authorize this machine' : 'New code'}
          onPress={mint}
        />
      </Col>
    </Card>
  );
}
