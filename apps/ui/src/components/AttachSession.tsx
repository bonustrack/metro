import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { QrCode } from '@stage-labs/kit/react-native/qr-code';
import { colors } from '@stage-labs/kit/tokens';
import { Text, Button, Input } from './ui';

const CODE_INPUT = { flexGrow: 1, minWidth: 200 } as const;

const QR_INK = colors['link-light'];
const QR_PAPER = colors['bg-light'];
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import {
  cancelAttachSession,
  pollAttachSession,
  submitAttachStep,
  type AttachSession as Session,
} from '../api/attach-session';
import { stationLabel, type AttachResult } from '../api/attach';

const POLL_MS = 2_000;

interface AttachSessionProps {
  token: string;
  agentId: string;
  session: Session;
  onUpdate: (session: Session) => void;
  onDone: (result: AttachResult) => void;
  onClose: () => void;
}

function Waiting({ label }: { label: string }): ReactNode {
  return (
    <Text size="sm" role="secondary">
      {label}
    </Text>
  );
}

function PairingCode({ code }: { code: string }): ReactNode {
  return (
    <Text size="2xl" weight="semibold" variant="mono" selectable>
      {code}
    </Text>
  );
}

function CodeEntry({
  step,
  busy,
  onSubmit,
}: {
  step: 'code' | 'password';
  busy: boolean;
  onSubmit: (value: string) => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [value, setValue] = useState('');
  const send = (): void => {
    if (value.trim() !== '' && !busy) onSubmit(value.trim());
  };
  return (
    <Row gap={10} align="center" wrap>
      <Input
        name={`attach-${step}`}
        value={value}
        placeholder={step === 'code' ? '12345' : 'your 2FA password'}
        inputType={step === 'code' ? 'number' : 'password'}
        disabled={busy}
        dark={dark}
        onChangeText={setValue}
        onSubmit={send}
        style={CODE_INPUT}
      />
      <Button
        color="primary"
        dark={dark}
        onPress={send}
        loading={busy}
        disabled={busy || value.trim() === ''}
        label={step === 'code' ? 'Sign in' : 'Unlock'}
      />
    </Row>
  );
}

function StepBody({
  session,
  busy,
  onSubmit,
}: {
  session: Session;
  busy: boolean;
  onSubmit: (input: { code?: string; password?: string }) => void;
}): ReactNode {
  const { step, qr, pairingCode } = session;
  if (step === 'scan')
    return qr === null ? (
      <Waiting label="Waiting for WhatsApp to hand over a QR code." />
    ) : (
      <QrCode
        value={qr}
        size={220}
        color={QR_INK}
        background={QR_PAPER}
      />
    );
  if (step === 'pair')
    return pairingCode === null ? (
      <Waiting label="Asking WhatsApp for a pairing code." />
    ) : (
      <PairingCode code={pairingCode} />
    );
  if (step === 'code' || step === 'password')
    return (
      <CodeEntry
        step={step}
        busy={busy}
        onSubmit={(value) => {
          onSubmit(step === 'code' ? { code: value } : { password: value });
        }}
      />
    );
  return null;
}

export function AttachSession(props: AttachSessionProps): ReactNode {
  const { token, agentId, session, onUpdate, onDone, onClose } = props;
  const dark = useKitScheme() === 'dark';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (session.status !== 'pending') return undefined;
    const timer = setInterval(() => {
      void pollAttachSession(token, agentId, session.attachId)
        .then((next) => {
          if (live.current) onUpdate(next);
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [session.attachId, session.status, token, agentId]);

  useEffect(() => {
    if (session.status !== 'done') return;
    onDone({
      station: session.station,
      accountId: session.accountId ?? '',
      identity: session.identity,
      activated: session.activated,
      secret: null,
    });
  }, [session.status]);

  const submit = (input: { code?: string; password?: string }): void => {
    setBusy(true);
    setError(null);
    submitAttachStep(token, agentId, session.attachId, input)
      .then((next) => {
        if (live.current) onUpdate(next);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'That did not work.');
      })
      .finally(() => {
        if (live.current) setBusy(false);
      });
  };

  const stop = (): void => {
    void cancelAttachSession(token, agentId, session.attachId).catch(
      () => undefined,
    );
    onClose();
  };

  return (
    <Col gap={14}>
        <Col gap={4}>
          <Text size="lg" weight="semibold">
            Connecting {stationLabel(session.station)}
          </Text>
          <Text size="sm" role="secondary">
            {session.prompt}
          </Text>
        </Col>
        <StepBody session={session} busy={busy} onSubmit={submit} />
        {session.status === 'failed' ? (
          <Text size="sm" role="danger">
            {session.error ?? 'That sign-in failed.'}
          </Text>
        ) : null}
        {error !== null ? (
          <Text size="sm" role="danger">
            {error}
          </Text>
        ) : null}
        <Row justify="between" align="center" gap={12} wrap>
          <Text size="sm" role="secondary">
            Nothing is stored until the sign-in completes. Metro drops it after
            five minutes.
          </Text>
          <Button
            size="sm"
            color="secondary"
            dark={dark}
            onPress={stop}
            label={session.status === 'pending' ? 'Cancel' : 'Close'}
          />
        </Row>
    </Col>
  );
}
