import { type ReactNode, useEffect, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { offeredStations, type AttachResult } from '@metro-labs/client/api/attach';
import { agentsUrl } from '@metro-labs/client/api/client';
import { GMAIL_MANAGED } from '@metro-labs/client/api/gmail';
import { AttachedAccount } from './AttachedAccount.js';
import { AttachSession } from './AttachSession.js';
import { Modal } from './Modal.js';
import { StationForm } from './StationForm.js';
import { StationPicker } from './StationPicker.js';
import { useAttach } from '../lib/use-attach.js';

const TAIL = ['xmtp', 'webhook'];

const rank = (station: string): number => {
  const at = TAIL.indexOf(station);
  return at === -1 ? -1 : at;
};

function orderStations(attachable: string[]): string[] {
  return offeredStations(attachable).sort((a, b) => rank(a) - rank(b));
}

interface ConnectStationProps {
  agentId: string;
  attachable: string[];
  features: string[];
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

function ConnectContent({ agentId, attachable, features, onClose, onChanged }: ConnectStationProps): ReactNode {
  const [station, setStation] = useState<string | null>(null);
  const [result, setResult] = useState<AttachResult | null>(null);
  const attach = useAttach(agentId);
  const known = orderStations(attachable);
  const pending = attach.started?.kind === 'pending' ? attach.started.session : null;

  const done = (next: AttachResult): void => {
    setResult(next);
    onChanged();
  };

  useEffect(() => {
    if (attach.started?.kind === 'done') done(attach.started.result);
  }, [attach.started]);

  const close = (): void => {
    attach.close();
    onClose();
  };

  return (
    <Modal title="Connect channel" open onClose={close}>
      {result !== null ? <AttachedAccount result={result} onDismiss={close} /> : pending !== null ? (
        <AttachSession agentId={agentId} base={attach.base} identity={attach.identity} session={pending} onUpdate={attach.update} onDone={done} onClose={close} />
      ) : station !== null ? (
        <StationForm
          station={station}
          gmailManaged={features.includes(GMAIL_MANAGED)}
          busy={attach.busy}
          error={attach.error}
          onBack={() => { attach.clearError(); setStation(null); }}
          onStart={(fields) => { attach.start(station, fields); }}
        />
      ) : (
        <Col gap={12}>
          <Text size="2xs" role="secondary">
            {known.length === 0
              ? 'This Metro daemon offers no channel you can connect.'
              : 'Pick where this agent should be reachable.'}
          </Text>
          <StationPicker stations={known} disabled={false} onPick={setStation} />
        </Col>
      )}
    </Modal>
  );
}

export function ConnectStation(props: ConnectStationProps): ReactNode {
  return props.open ? <ConnectContent key={`${agentsUrl()}/${props.agentId}`} {...props} /> : null;
}
