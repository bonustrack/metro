import { type ReactNode, useEffect, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { loadAccount } from '../auth/account.js';
import { pageTitle } from '../title.js';
import { stationLabel } from '../api/attach.js';
import { finishReturn, type ReturnOutcome, type ReturnedSignIn } from '../api/sign-in-return.js';

const WIDTH = 480;

let running: Promise<ReturnOutcome> | null = null;

function finishOnce(ret: ReturnedSignIn): Promise<ReturnOutcome> {
  if (running === null) {
    loadAccount();
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    running = finishReturn(ret);
  }
  return running;
}

export function SignInReturn({ ret }: { ret: ReturnedSignIn }): ReactNode {
  const [outcome, setOutcome] = useState<ReturnOutcome | null>(null);

  useEffect(() => {
    document.title = pageTitle('Sign in');
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
          <Text size="xs" role="secondary">Finishing the sign-in…</Text>
        ) : outcome.ok ? (
          <Text size="xs">{stationLabel(outcome.station)} is connected. You can close this tab.</Text>
        ) : (
          <>
            <Text size="xs" role="danger">{outcome.message}</Text>
            <Text size="2xs">
              <a className="hint-link" href={`/${outcome.backHash ?? '#/'}`}>
                Try again
              </a>
            </Text>
          </>
        )}
      </Col>
    </Row>
  );
}
