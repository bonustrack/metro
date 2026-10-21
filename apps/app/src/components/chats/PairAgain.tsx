import { type ReactNode, useEffect, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { stationLabel } from '@metro-labs/client/api/attach';
import { pairAgainLines } from '@metro-labs/client/api/pair-again';
import { Modal, ModalText } from '../Modal.js';
import { AttachSession } from '../AttachSession.js';
import { useAttach } from '../../lib/use-attach.js';
import { logError } from '../../lib/log.js';

interface PairAgainProps {
  agentId: string;
  station: string;
  accountId: string;
  handle: string | undefined;
  replaces: boolean;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}

const digitsOf = (handle: string | undefined): string => handle?.replace(/[^0-9]/g, '') ?? '';

export function PairAgain({ agentId, station, accountId, handle, replaces, onClose, onSaved }: PairAgainProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const attach = useAttach(agentId);
  const [done, setDone] = useState(false);
  const label = stationLabel(station);
  const session = attach.started?.kind === 'pending' ? attach.started.session : null;
  const phone = digitsOf(handle);

  useEffect(() => {
    if (done) onSaved().catch(logError('refresh after pairing again'));
  }, [done]);

  const close = (): void => {
    attach.close();
    onClose();
  };

  const start = (fields: Record<string, string>): void => {
    attach.start(station, fields, accountId);
  };

  return (
    <Modal title={`Pair ${label} again`} open onClose={close}>
      {done ? (
        <Col gap={14}>
          <ModalText>{`Paired again. ${label} reconnects within a few seconds.`}</ModalText>
          <Button color="secondary" dark={dark} label="Done" onPress={close} />
        </Col>
      ) : session !== null ? (
        <AttachSession agentId={agentId} base={attach.base} identity={attach.identity} session={session} onUpdate={attach.update} onDone={() => { setDone(true); }} onClose={close} />
      ) : (
        <Col gap={14}>
          {pairAgainLines(label, handle, replaces).map((line) => (
            <ModalText key={line}>{line}</ModalText>
          ))}
          {attach.error === null ? null : <Text size="md" role="danger">{attach.error}</Text>}
          <Button color="primary" dark={dark} label="Scan a QR code" disabled={attach.busy} loading={attach.busy} onPress={() => { start({}); }} />
          {phone === '' ? null : <Button color="secondary" dark={dark} label={`Use a pairing code for ${handle ?? ''}`} disabled={attach.busy} onPress={() => { start({ phone }); }} />}
        </Col>
      )}
    </Modal>
  );
}
