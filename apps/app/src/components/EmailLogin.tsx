import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { sendEmailCode, verifyEmailCode, type Intent } from '@metro-labs/client/api/auth';
import { LabeledField } from './LabeledField.js';
import { land } from '../lib/land.js';
import { CENTER_TEXT, FULL_WIDTH } from '../lib/style.js';

const CODE_RE = /^\d{6}$/;

interface Step {
  sentTo: string | null;
  busy: boolean;
  error: string | null;
}

function CodeLinks({ busy, onResend, onReset }: { busy: boolean; onResend: () => void; onReset: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row justify="center" gap={16} wrap>
      <Button size="md" color="secondary" variant="ghost" dark={dark} label="Send a new code" disabled={busy} onPress={onResend} />
      <Button size="md" color="secondary" variant="ghost" dark={dark} label="Use another email" disabled={busy} onPress={onReset} />
    </Row>
  );
}

export function EmailLogin({ intent }: { intent: Intent }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ sentTo: null, busy: false, error: null });
  const run = (work: () => Promise<Partial<Step>>): void => {
    setStep((s) => ({ ...s, busy: true, error: null }));
    work()
      .then((next) => {
        setStep((s) => ({ ...s, busy: false, ...next }));
      })
      .catch((err: unknown) => {
        setStep((s) => ({ ...s, busy: false, error: err instanceof Error ? err.message : 'That did not work. Try again.' }));
      });
  };
  const send = (): void => {
    const address = email.trim();
    if (address === '' || step.busy) return;
    run(async () => {
      await sendEmailCode(address, intent);
      setCode('');
      return { sentTo: address };
    });
  };
  const verify = (): void => {
    const sentTo = step.sentTo;
    if (sentTo === null || !CODE_RE.test(code.trim()) || step.busy) return;
    run(async () => {
      land(await verifyEmailCode(sentTo, code.trim(), intent));
      return { busy: true };
    });
  };
  return (
    <Col gap={10}>
      {step.sentTo === null ? (
        <LabeledField label="Email" name="email" value={email} placeholder="e. g. alice@stage.box" inputMode="email" disabled={step.busy} onChangeText={setEmail} onSubmit={send} />
      ) : (
        <>
          <Text size="xs" style={CENTER_TEXT}>
            {`We sent a code to ${step.sentTo}. Enter the six digits here.`}
          </Text>
          <LabeledField label="Code" name="code" value={code} placeholder="e. g. 123456" inputMode="numeric" autoFocus disabled={step.busy} onChangeText={setCode} onSubmit={verify} />
        </>
      )}
      <Button size="lg" color="primary" dark={dark} label={step.sentTo === null ? 'Continue' : 'Log in'} loading={step.busy} disabled={step.busy} style={FULL_WIDTH} onPress={step.sentTo === null ? send : verify} />
      {step.sentTo === null ? null : (
        <CodeLinks
          busy={step.busy}
          onResend={send}
          onReset={() => {
            setStep({ sentTo: null, busy: false, error: null });
          }}
        />
      )}
      {step.error === null ? null : (
        <Text size="xs" role="danger" style={CENTER_TEXT}>
          {step.error}
        </Text>
      )}
    </Col>
  );
}
