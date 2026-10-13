import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { activeAccount } from '@metro-labs/client/auth/account';
import { createEnrollment, type Enrollment } from '@metro-labs/client/api/enrollment';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { useConnectorScope } from '../lib/org-connector-queries.js';
import { queryError } from '../lib/queries.js';
import { Modal } from './Modal.js';
import { SettingsGroup, SettingsSection } from './SettingsSection.js';

const NOTE = 'Links this agent to your organization. It turns nothing on and moves no connectors.';

function EnrollmentDialog({ enrollment, server, onClose, onEnrolled }: { enrollment: Enrollment; server: Server; onClose: () => void; onEnrolled: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = activeAccount();
  useEffect(() => () => { enrollment.dispose(); }, [enrollment]);
  const confirm = (): void => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    enrollment.run().then(onEnrolled).catch((err: unknown) => {
      setError(queryError(err, 'Enrollment could not be confirmed. Try again.'));
    }).finally(() => {
      pending.current = false;
      setBusy(false);
    });
  };
  return <Modal title="Enroll with organization?" open onClose={onClose}>
    <Col gap={16}>
      <Text size="md">{`Enroll ${serverLabel(server)} with ${account?.organizationName ?? account?.organization ?? 'your organization'}?`}</Text>
      <Text size="md" role="secondary">{`Agent: ${server.id} · ${server.host}`}</Text>
      <Text size="md" role="secondary">{NOTE}</Text>
      <Text size="md" role="secondary">If already enrolled, this replaces its identity and turns connector sync off, even if it fails. Turn sync back on when ready. Closing does not cancel it.</Text>
      {error === null ? null : <Text size="md" role="danger">{error}</Text>}
      <Row justify="between" gap={12} wrap>
        <Button color="secondary" dark={dark} label={busy ? 'Close' : 'Cancel'} onPress={onClose} />
        <Button color="primary" dark={dark} label={error === null ? 'Enroll agent' : 'Retry enrollment'} accessibilityLabel={busy ? 'Enrolling agent' : error === null ? 'Enroll agent' : 'Retry enrollment'} loading={busy} disabled={busy} onPress={confirm} />
      </Row>
    </Col>
  </Modal>;
}

function EnrollmentSection({ server }: { server: Server }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [enrolled, setEnrolled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = (): void => { enrollment?.dispose(); setEnrollment(null); };
  const open = (): void => {
    setError(null);
    try { setEnrollment(createEnrollment(server)); } catch { setError('Select a registered agent with a valid address before enrolling.'); }
  };
  return <SettingsGroup title="Organization">
    <SettingsSection title={enrolled ? 'Enrolled with organization' : 'Organization enrollment'} note={NOTE}>
      {enrolled ? <Text size="md">Enrollment confirmed.</Text> : <Button color="secondary" dark={dark} label="Enroll with organization" onPress={open} />}
      {error === null ? null : <Text size="md" role="danger">{error}</Text>}
    </SettingsSection>
    {enrollment === null ? null : <EnrollmentDialog enrollment={enrollment} server={server} onClose={close} onEnrolled={() => { setEnrolled(true); close(); }} />}
  </SettingsGroup>;
}

export function EnrollAgent({ server }: { server: Server }): ReactNode {
  const scope = useConnectorScope();
  if (activeAccount()?.role !== 'admin') return null;
  return <EnrollmentSection key={`${String(scope)}:${server.id}:${server.host}`} server={server} />;
}
