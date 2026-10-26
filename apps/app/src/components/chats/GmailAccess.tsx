import { type ReactNode, useEffect, useState } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Button } from '@stage-labs/kit/react-native/button';
import { Modal } from '../Modal.js';
import { Text } from '@stage-labs/kit/react-native/text';
import { type AccountRow } from '@metro-labs/client/api/accounts';
import { agentsUrl } from '@metro-labs/client/api/client';
import { GMAIL_MANAGED, GMAIL_SENDING_CONSENT, gmailAccess, gmailUpgradeFields } from '@metro-labs/client/api/gmail';
import { useAttach } from '../../lib/use-attach.js';
import { logError } from '../../lib/log.js';
import { AttachSession } from '../AttachSession.js';
import { Item } from '../ui/Item.js';
import { Group } from '../ui/Group.js';

interface UpgradeProps {
  agentId: string;
  accountId: string;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}

function Upgrade({ agentId, accountId, onClose, onSaved }: UpgradeProps): ReactNode {
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
        <Column gap={14}>
          <Text size="xs">Sending authorized with Google.</Text>
          <Text size="md" color="secondary">Metro's rule is unchanged. Set Write to Allow or Ask to let the agent send.</Text>
          <Button color="secondary" label="Done" onPress={close} />
        </Column>
      ) : session !== null ? (
        <AttachSession agentId={agentId} base={attach.base} identity={attach.identity} session={session} onUpdate={attach.update} onDone={complete} onClose={close} />
      ) : (
        <Column gap={14}>
          <Text size="xs">{GMAIL_SENDING_CONSENT}</Text>
          {attach.error === null ? null : <Text size="md" color="danger">{attach.error}</Text>}
          <Button color="primary" label="Continue to Google" disabled={attach.busy} loading={attach.busy} onPress={() => { attach.start('gmail', gmailUpgradeFields(accountId)); }} />
        </Column>
      )}
    </Modal>
  );
}

interface GmailAccessProps {
  agentId: string;
  row: AccountRow;
  features: string[];
  onSaved: () => Promise<unknown>;
}

export function GmailAccess({ agentId, row, features, onSaved }: GmailAccessProps): ReactNode {
  const [open, setOpen] = useState(false);
  const supported = features.includes(GMAIL_MANAGED);
  const access = gmailAccess(supported, row.sendEnabled);
  return (
    <Group label="Gmail access">
      <Item
        title={access.title}
        subtitle={access.note}
        trailing={!access.upgrade || row.id === null ? undefined : <Button size="sm" color="secondary" label="Allow sending" onPress={() => { setOpen(true); }} />}
      />
      {!open || !supported || row.id === null ? null : (
        <Upgrade key={`${agentsUrl()}/${agentId}/${row.id}`} agentId={agentId} accountId={row.id} onSaved={onSaved} onClose={() => { setOpen(false); }} />
      )}
    </Group>
  );
}
