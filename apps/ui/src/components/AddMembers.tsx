import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Textarea } from '@stage-labs/kit/react-native/textarea';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { GROW } from '../theme';
import { Modal } from './Modal';
import { addMember, type ProjectRole } from '../api/projects';
import { queryError } from '../api/queries';

const SEPARATORS = /[\s,;]+/;
const ROLES: ProjectRole[] = ['member', 'admin'];
const PLACEHOLDER = 'ada@example.com, grace@example.com';

export function addressesIn(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(SEPARATORS)) {
    const address = part.trim().toLowerCase();
    if (address !== '') seen.add(address);
  }
  return [...seen];
}

function RolePicker({
  role,
  busy,
  dark,
  onRole,
}: {
  role: ProjectRole;
  busy: boolean;
  dark: boolean;
  onRole: (role: ProjectRole) => void;
}): ReactNode {
  return (
    <Row gap={8} align="center" wrap>
      <Text size="sm" role="secondary">
        Role
      </Text>
      {ROLES.map((option) => (
        <Button
          key={option}
          size="sm"
          color={option === role ? 'primary' : 'secondary'}
          dark={dark}
          disabled={busy}
          label={option === 'admin' ? 'Admin' : 'Member'}
          onPress={() => {
            onRole(option);
          }}
        />
      ))}
    </Row>
  );
}

interface AddMembersProps {
  token: string;
  project: string;
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}

export function AddMembers({
  token,
  project,
  open,
  onClose,
  onAdded,
}: AddMembersProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [raw, setRaw] = useState('');
  const [role, setRole] = useState<ProjectRole>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addresses = addressesIn(raw);

  const close = (): void => {
    if (busy) return;
    setRaw('');
    setError(null);
    onClose();
  };

  const submit = (): void => {
    if (busy || addresses.length === 0) return;
    setBusy(true);
    setError(null);
    const refused: string[] = [];
    const each = addresses.map((address) =>
      addMember(token, project, address, role).catch((err: unknown) => {
        refused.push(`${address} (${queryError(err, 'refused')})`);
      }),
    );
    Promise.all(each)
      .then(() => {
        onAdded();
        if (refused.length === 0) {
          setRaw('');
          onClose();
          return;
        }
        setError(`Could not add ${refused.join(', ')}`);
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not add those members.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const label =
    addresses.length > 1
      ? `Add ${String(addresses.length)} members`
      : 'Add member';

  return (
    <Modal title="Add members" open={open} onClose={close}>
      <Col gap={14}>
        <Textarea
          name="member-emails"
          value={raw}
          placeholder={PLACEHOLDER}
          rows={3}
          disabled={busy}
          dark={dark}
          onChangeText={setRaw}
          style={GROW}
        />
        <RolePicker role={role} busy={busy} dark={dark} onRole={setRole} />
        {error === null ? null : (
          <Text size="sm" role="danger">
            {error}
          </Text>
        )}
        <Row justify="between" align="center" gap={12} wrap>
          <Button
            color="secondary"
            dark={dark}
            disabled={busy}
            onPress={close}
            label="Cancel"
          />
          <Button
            color="primary"
            dark={dark}
            loading={busy}
            disabled={busy || addresses.length === 0}
            onPress={submit}
            label={label}
          />
        </Row>
      </Col>
    </Modal>
  );
}
