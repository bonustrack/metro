import { type ReactNode, useEffect, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from './ui.js';
import { loadAccount } from '../auth/account.js';
import { pageTitle } from '../title.js';
import { finishReturn, type MicrosoftReturn, type ReturnOutcome } from '../api/outlook-return.js';

const WIDTH = 480;

let running: Promise<ReturnOutcome> | null = null;

function finishOnce(ret: MicrosoftReturn): Promise<ReturnOutcome> {
  if (running === null) {
    loadAccount();
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    running = finishReturn(ret);
  }
  return running;
}

export function OutlookReturn({ ret }: { ret: MicrosoftReturn }): ReactNode {
  const [outcome, setOutcome] = useState<ReturnOutcome | null>(null);

  useEffect(() => {
    document.title = pageTitle('Outlook');
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
          <Text role="secondary">Finishing the Microsoft sign-in…</Text>
        ) : outcome.ok ? (
          <Text>Outlook is connected. You can close this tab.</Text>
        ) : (
          <>
            <Text role="danger">{outcome.message}</Text>
            <Text size="sm">
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
