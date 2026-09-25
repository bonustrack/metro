import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { sendEmailCode, verifyEmailCode, type Intent } from '../api/auth.js';

const FULL_WIDTH = { alignSelf: 'stretch' } as const;
const CENTER_TEXT = { textAlign: 'center' } as const;
const CODE_RE = /^\d{6}$/;

function land(hash: string): void {
  window.history.replaceState(null, '', `${window.location.pathname}${hash}`);
  window.location.reload();
}

interface Step {
  sentTo: string | null;
  busy: boolean;
  error: string | null;
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
        <Input name="email" value={email} placeholder="name@company.com" inputType="email" autoFocus={false} disabled={step.busy} dark={dark} onChangeText={setEmail} onSubmit={send} style={FULL_WIDTH} />
      ) : (
        <>
          <Text size="md" style={CENTER_TEXT}>
            {`We sent a code to ${step.sentTo}. Enter the six digits here.`}
          </Text>
          <Input name="code" value={code} placeholder="123456" inputType="number" autoFocus disabled={step.busy} dark={dark} onChangeText={setCode} onSubmit={verify} style={FULL_WIDTH} />
        </>
      )}
      <Button
        size="lg"
        color="secondary"
        dark={dark}
        label={step.sentTo === null ? 'Continue with email' : 'Log in'}
        loading={step.busy}
        disabled={step.busy}
        style={FULL_WIDTH}
        onPress={step.sentTo === null ? send : verify}
      />
      {step.sentTo === null ? null : (
        <Row justify="center" gap={16}>
          <Button size="sm" color="secondary" variant="ghost" dark={dark} label="Send a new code" disabled={step.busy} onPress={send} />
          <Button
            size="sm"
            color="secondary" variant="ghost"
            dark={dark}
            label="Use another email"
            disabled={step.busy}
            onPress={() => {
              setStep({ sentTo: null, busy: false, error: null });
            }}
          />
        </Row>
      )}
      {step.error === null ? null : (
        <Text size="md" role="danger" style={CENTER_TEXT}>
          {step.error}
        </Text>
      )}
    </Col>
  );
}
