import { type ReactNode, useEffect, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Modal } from './Modal.js';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { type AccountRow } from '@metro-labs/client/api/accounts';
import { agentsUrl } from '@metro-labs/client/api/client';
import { GMAIL_MANAGED, GMAIL_SENDING_CONSENT, gmailAccess, gmailUpgradeFields } from '@metro-labs/client/api/gmail';
import { useAttach } from '../lib/use-attach.js';
import { logError } from '../lib/log.js';
import { AttachSession } from './AttachSession.js';
import { SettingsGroup, SettingsSection } from './SettingsSection.js';

interface UpgradeProps {
  agentId: string;
  accountId: string;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}

function Upgrade({ agentId, accountId, onClose, onSaved }: UpgradeProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const attach = useAttach(agentId);
  const [done, setDone] = useState(false);
  const session = attach.started?.kind === 'pending' ? attach.started.session : null;
  const complete = (): void => { setDone(true); };

  useEffect(() => {
    if (attach.started?.kind === 'done') setDone(true);
  }, [attach.started]);

  useEffect(() => {
    if (done) onSaved().catch(logError('refresh Gmail authorization'));
  }, [done]);

  const close = (): void => {
    attach.close();
    onClose();
  };

  return (
    <Modal title="Allow sending with Google" open onClose={close}>
      {done ? (
        <Col gap={14}>
          <Text size="xs">Sending authorized with Google.</Text>
          <Text size="2xs" role="secondary">Metro Write permission has not changed. Choose Allow or Ask in the permissions below when you want the agent to send.</Text>
          <Button color="secondary" dark={dark} label="Done" onPress={close} />
        </Col>
      ) : session !== null ? (
        <AttachSession agentId={agentId} base={attach.base} identity={attach.identity} session={session} onUpdate={attach.update} onDone={complete} onClose={close} />
      ) : (
        <Col gap={14}>
          <Text size="xs">{GMAIL_SENDING_CONSENT}</Text>
          {attach.error === null ? null : <Text size="2xs" role="danger">{attach.error}</Text>}
          <Button color="primary" dark={dark} label="Continue to Google" disabled={attach.busy} loading={attach.busy} onPress={() => { attach.start('gmail', gmailUpgradeFields(accountId)); }} />
        </Col>
      )}
    </Modal>
  );
}

interface GmailSettingsProps {
  agentId: string;
  row: AccountRow;
  features: string[];
  onSaved: () => Promise<unknown>;
}

export function GmailSettings({ agentId, row, features, onSaved }: GmailSettingsProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [open, setOpen] = useState(false);
  const supported = features.includes(GMAIL_MANAGED);
  const access = gmailAccess(supported, row.sendEnabled);
  return (
    <SettingsGroup title="Gmail access">
      <SettingsSection title={access.title} note={access.note}>
        {!access.upgrade || row.id === null ? null : (
          <Button color="secondary" dark={dark} label="Allow sending with Google" onPress={() => { setOpen(true); }} />
        )}
      </SettingsSection>
      {!open || !supported || row.id === null ? null : (
        <Upgrade key={`${agentsUrl()}/${agentId}/${row.id}`} agentId={agentId} accountId={row.id} onSaved={onSaved} onClose={() => { setOpen(false); }} />
      )}
    </SettingsGroup>
  );
}
