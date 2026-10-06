import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type AccountIdentity } from '@metro-labs/client/auth/account';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { QrCode } from '@stage-labs/kit/react-native/qr-code';
import { colors } from '@stage-labs/kit/tokens';
import { Button } from '@stage-labs/kit/react-native/button';
import { FormField } from './FormField.js';
import { Text } from '@stage-labs/kit/react-native/text';

const CODE_INPUT = { flexGrow: 1, minWidth: 200 } as const;

const QR_INK = colors['link-light'];
const QR_PAPER = colors['bg-light'];
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import {
  pollAttachSession,
  submitAttachStep,
  type AttachSession as Session,
  type StepBody as StepInput,
} from '@metro-labs/client/api/attach-session';
import { STATION_FORMS, stationLabel, type AttachResult } from '@metro-labs/client/api/attach';
import { DeviceSignIn } from './DeviceSignIn.js';
import { BrowserSignIn } from './BrowserSignIn.js';
import { logError } from '../lib/log.js';

const POLL_MS = 2_000;

interface AttachSessionProps {
  agentId: string;
  base: string;
  identity: AccountIdentity | null;
  session: Session;
  onUpdate: (session: Session) => void;
  onDone: (result: AttachResult) => void;
  onClose: () => void;
}

function Waiting({ label }: { label: string }): ReactNode {
  return (
    <Text size="2xs" role="secondary">
      {label}
    </Text>
  );
}

function PairingCode({ code }: { code: string }): ReactNode {
  return (
    <Text size="lg" weight="semibold" selectable>
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
      <FormField label={step === 'code' ? 'Sign-in code' : '2FA password'}
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
      <Button size="lg"
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

function BrowserStep({
  agentId,
  base,
  identity,
  session,
  busy,
  onSubmit,
}: {
  agentId: string;
  base: string;
  identity: AccountIdentity | null;
  session: Session;
  busy: boolean;
  onSubmit: (input: StepInput) => void;
}): ReactNode {
  if (session.step === 'device')
    return session.userCode === null ? (
      <Waiting label="Asking Microsoft for a sign-in code." />
    ) : (
      <DeviceSignIn code={session.userCode} uri={session.verificationUri} />
    );
  const form = STATION_FORMS[session.station];
  const provider = form?.provider ?? stationLabel(session.station);
  return session.authorizeUrl === null ? (
    <Waiting label={`Preparing the ${provider} sign-in.`} />
  ) : (
    <BrowserSignIn
      agentId={agentId}
      base={base}
      identity={identity}
      attachId={session.attachId}
      authorizeUrl={session.authorizeUrl}
      provider={provider}
      busy={busy}
      onUseCode={
        form?.codeFallback === true
          ? () => {
              onSubmit({ mode: 'device' });
            }
          : null
      }
    />
  );
}

function StepBody({
  agentId,
  base,
  identity,
  session,
  busy,
  onSubmit,
}: {
  agentId: string;
  base: string;
  identity: AccountIdentity | null;
  session: Session;
  busy: boolean;
  onSubmit: (input: StepInput) => void;
}): ReactNode {
  const { step, qr, pairingCode } = session;
  if (step === 'browser' || step === 'device')
    return <BrowserStep agentId={agentId} base={base} identity={identity} session={session} busy={busy} onSubmit={onSubmit} />;
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
  const { agentId, base, identity, session, onUpdate, onDone, onClose } = props;
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
    let active = true;
    const timer = setInterval(() => {
      pollAttachSession(agentId, session.attachId, base, identity)
        .then((next) => {
          if (active && live.current) onUpdate(next);
        })
        .catch(logError('poll channel sign-in'));
    }, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [session.attachId, session.status, agentId, base, identity]);

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

  const submit = (input: StepInput): void => {
    setBusy(true);
    setError(null);
    submitAttachStep(agentId, session.attachId, input, base, identity)
      .then((next) => {
        if (live.current) onUpdate(next);
      })
      .catch((err: unknown) => {
        if (live.current) setError(err instanceof Error ? err.message : 'That did not work.');
      })
      .finally(() => {
        if (live.current) setBusy(false);
      });
  };

  return (
    <Col gap={14}>
        <Col gap={4}>
          <Text size="sm" weight="medium">
            Connecting {stationLabel(session.station)}
          </Text>
          <Text size="2xs" role="secondary">
            {session.prompt}
          </Text>
        </Col>
        <StepBody agentId={agentId} base={base} identity={identity} session={session} busy={busy} onSubmit={submit} />
        {session.status === 'failed' ? (
          <Text size="2xs" role="danger">
            {session.error ?? 'That sign-in failed.'}
          </Text>
        ) : null}
        {error !== null ? (
          <Text size="2xs" role="danger">
            {error}
          </Text>
        ) : null}
        <Row justify="between" align="center" gap={12} wrap>
          <Text size="2xs" role="secondary">
            Nothing is stored until the sign-in completes. Metro drops an
            unfinished sign-in after a few minutes.
          </Text>
          <Button
            size="md"
            color="secondary"
            dark={dark}
            onPress={onClose}
            label={session.status === 'pending' ? 'Cancel' : 'Close'}
          />
        </Row>
    </Col>
  );
}
