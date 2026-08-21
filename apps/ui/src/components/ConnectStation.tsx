import { type ReactNode, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from './ui';
import { STATION_FORMS, type AttachResult } from '../api/attach';
import { type AttachSession as Session } from '../api/attach-session';
import { AttachedAccount } from './AttachedAccount';
import { AttachSession } from './AttachSession';
import { Modal } from './Modal';
import { StationForm } from './StationForm';
import { StationPicker } from './StationPicker';

const TAIL = ['xmtp', 'webhook'];

const rank = (station: string): number => {
  const at = TAIL.indexOf(station);
  return at === -1 ? -1 : at;
};

function orderStations(attachable: string[]): string[] {
  return attachable
    .filter((s) => STATION_FORMS[s] !== undefined)
    .sort((a, b) => rank(a) - rank(b));
}

type Step =
  | { kind: 'pick' }
  | { kind: 'form'; station: string }
  | { kind: 'session'; session: Session }
  | { kind: 'done'; result: AttachResult };

interface ConnectStationProps {
  token: string;
  agentId: string;
  attachable: string[];
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

export function ConnectStation(props: ConnectStationProps): ReactNode {
  const { token, agentId, attachable, open, onClose, onChanged } = props;
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const known = orderStations(attachable);

  const close = (): void => {
    setStep({ kind: 'pick' });
    onClose();
  };

  return (
    <Modal title="Connect station" open={open} onClose={close}>
      {step.kind === 'pick' ? (
        <Col gap={12}>
          <Text size="sm" role="secondary">
            {known.length === 0
              ? 'This Metro daemon offers no station you can connect.'
              : 'Pick the network this agent should be reachable on.'}
          </Text>
          <StationPicker
            stations={known}
            disabled={false}
            onPick={(station) => {
              setStep({ kind: 'form', station });
            }}
          />
        </Col>
      ) : null}

      {step.kind === 'form' ? (
        <StationForm
          token={token}
          agentId={agentId}
          station={step.station}
          onBack={() => {
            setStep({ kind: 'pick' });
          }}
          onPending={(session) => {
            setStep({ kind: 'session', session });
          }}
          onAttached={(result) => {
            setStep({ kind: 'done', result });
            onChanged();
          }}
        />
      ) : null}

      {step.kind === 'session' ? (
        <AttachSession
          token={token}
          agentId={agentId}
          session={step.session}
          onUpdate={(session) => {
            setStep({ kind: 'session', session });
          }}
          onDone={(result) => {
            setStep({ kind: 'done', result });
            onChanged();
          }}
          onClose={close}
        />
      ) : null}

      {step.kind === 'done' ? (
        <AttachedAccount result={step.result} onDismiss={close} />
      ) : null}
    </Modal>
  );
}
