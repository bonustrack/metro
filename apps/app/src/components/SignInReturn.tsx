import { type ReactNode, useEffect, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { loadAccount } from '@metro-labs/client/auth/account';
import { stationLabel } from '@metro-labs/client/api/attach';
import { finishReturn, type ReturnOutcome, type ReturnedSignIn } from '@metro-labs/client/api/sign-in-return';
import { location } from '@metro-labs/client/platform';
import { TextLink } from './TextLink.js';
import { noteTitle } from '../lib/title.js';

const WIDTH = 480;

let running: Promise<ReturnOutcome> | null = null;

function finishOnce(ret: ReturnedSignIn): Promise<ReturnOutcome> {
  if (running === null) {
    loadAccount();
    location().clearSearch('');
    running = finishReturn(ret);
  }
  return running;
}

function Outcome({ outcome }: { outcome: ReturnOutcome }): ReactNode {
  if (outcome.ok) return <Text size="xs">{stationLabel(outcome.station)} is connected. You can close this tab.</Text>;
  return (
    <>
      <Text size="xs" role="danger">
        {outcome.message}
      </Text>
      <TextLink to={outcome.backHash ?? '#/'}>Try again</TextLink>
    </>
  );
}

export function SignInReturn({ ret }: { ret: ReturnedSignIn }): ReactNode {
  const [outcome, setOutcome] = useState<ReturnOutcome | null>(null);
  useEffect(() => {
    noteTitle('Sign in');
    finishOnce(ret)
      .then(setOutcome)
      .catch((err: unknown) => {
        setOutcome({ ok: false, message: err instanceof Error ? err.message : 'Metro could not finish the sign-in.', backHash: null });
      });
  }, [ret]);
  return (
    <Row justify="center" align="center" flex={1} padding={24}>
      <Col gap={12} align="center" width="100%" maxWidth={WIDTH}>
        {outcome === null ? (
          <Text size="xs" role="secondary">
            Finishing the sign-in…
          </Text>
        ) : (
          <Outcome outcome={outcome} />
        )}
      </Col>
    </Row>
  );
}
