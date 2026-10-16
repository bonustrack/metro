import { type ReactNode, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { activeAccount } from '@metro-labs/client/auth/account';
import { fetchOrganization, inviteMember, removeMember, revokeInvitation, setMemberRole, type Invitation, type Member, type Organization, type Role } from '@metro-labs/client/api/organization';
import { AgentAvatar } from './AgentAvatar.js';
import { Choice } from './Choice.js';
import { Dropdown, type MenuItem } from './Dropdown.js';
import { FormField } from './FormField.js';
import { Icon } from './Icon.js';
import { KebabMenu } from './KebabMenu.js';
import { Modal, ModalText } from './Modal.js';
import { Actions } from './ui/Actions.js';
import { ErrorState } from './ui/ErrorState.js';
import { Group } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { RowsSkeleton } from './ui/RowsSkeleton.js';
import { orgKey, queryError } from '../lib/queries.js';
import { AVATAR_SIZE, ICON_SIZE } from './ui/sizes.js';

const ROLES_NOTE = 'Admins launch agents, add connectors, change models and invite. Members check on agents and approve.';
const NO_ASSIST = { autoCapitalize: 'none', autoCorrect: false, spellCheck: false, autoComplete: 'off' } as const;
const ROLE_WORD: Record<Role, string> = { admin: 'Admin', member: 'Member' };
const ROLE_TRIGGER = { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 6, marginRight: -6, borderRadius: 8 } as const;

const organizationKey = (): string[] => orgKey('organization');

export function useOrganizationQuery(): UseQueryResult<Organization> {
  return useQuery({ queryKey: organizationKey(), queryFn: () => fetchOrganization(), staleTime: 30_000 });
}

function useRun(onError: (text: string) => void, failure: string): (work: Promise<void>) => void {
  const client = useQueryClient();
  return (work) => {
    work.then(() => client.invalidateQueries({ queryKey: organizationKey() })).catch((err: unknown) => { onError(queryError(err, failure)); });
  };
}

function RoleMenu({ member, self, onError }: { member: Member; self: boolean; onError: (text: string) => void }): ReactNode {
  const palette = useKitPalette();
  const run = useRun(onError, 'Could not change that member.');
  const hover = { backgroundColor: palette.inputBg };
  const items: MenuItem[] = [
    ...(['admin', 'member'] as const).map((role): MenuItem => ({ label: ROLE_WORD[role], selected: member.role === role, onSelect: () => { if (member.role !== role) run(setMemberRole(member.membershipId, role)); } })),
    ...(self ? [] : [{ label: 'Remove from the organization', danger: true, onSelect: () => { run(removeMember(member.membershipId)); } }]),
  ];
  return (
    <Dropdown items={items} label={`Role of ${member.email ?? member.userId}`} style={ROLE_TRIGGER} hoverStyle={hover}>
      <Text size="md">{ROLE_WORD[member.role]}</Text>
      <Icon name="chevronDown" size={ICON_SIZE.sm} color={palette.sub} />
    </Dropdown>
  );
}

function MemberRow({ member, org, onError }: { member: Member; org: Organization; onError: (text: string) => void }): ReactNode {
  const self = member.userId === org.self;
  const email = member.email ?? member.userId;
  const subtitle = [member.name === null ? null : email, self ? 'you' : null].filter((part): part is string => part !== null).join(' · ');
  return (
    <Item title={member.name ?? email} subtitle={subtitle === '' ? undefined : subtitle} leading={<AgentAvatar seed={member.userId} src={member.picture} size={AVATAR_SIZE.row} />}
      value={org.role === 'admin' ? undefined : ROLE_WORD[member.role]} trailing={org.role === 'admin' ? <RoleMenu member={member} self={self} onError={onError} /> : undefined} />
  );
}

function InvitationRow({ invitation, org, onError }: { invitation: Invitation; org: Organization; onError: (text: string) => void }): ReactNode {
  const run = useRun(onError, 'Could not revoke that invitation.');
  const role = invitation.role === null ? 'Invited' : ROLE_WORD[invitation.role];
  return (
    <Item title={invitation.email} subtitle={`${role} · not accepted yet`} leading={<AgentAvatar seed={invitation.email} size={AVATAR_SIZE.row} />}
      trailing={org.role === 'admin' ? <KebabMenu ghost label={`Actions for the invitation of ${invitation.email}`} items={[{ label: 'Revoke the invitation', danger: true, onSelect: () => { run(revokeInvitation(invitation.id)); } }]} /> : undefined} />
  );
}

export function MembersGroups(): ReactNode {
  const { data, error, refetch } = useOrganizationQuery();
  const [failed, setFailed] = useState<string | null>(null);
  if (data === undefined)
    return (
      <Group label="Members">
        {error === null ? <RowsSkeleton rows={3} /> : <ErrorState title="Could not read the members" text={queryError(error, 'Metro did not answer.')} onRetry={refetch} />}
      </Group>
    );
  return (
    <>
      <Group label="Members" note={ROLES_NOTE} error={failed}>
        {data.members.map((m) => <MemberRow key={m.membershipId} member={m} org={data} onError={setFailed} />)}
      </Group>
      {data.invitations.length === 0 ? null : (
        <Group label="Invites">
          {data.invitations.map((inv) => <InvitationRow key={inv.id} invitation={inv} org={data} onError={setFailed} />)}
        </Group>
      )}
    </>
  );
}

function InviteModal({ onClose }: { onClose: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const send = (): void => {
    if (busy || email.trim() === '') return;
    setBusy(true);
    setSent(null);
    setError(null);
    inviteMember(email.trim(), role)
      .then(async () => {
        setSent(email.trim());
        setEmail('');
        await client.invalidateQueries({ queryKey: organizationKey() });
      })
      .catch((err: unknown) => { setError(queryError(err, 'Could not send the invitation.')); })
      .finally(() => { setBusy(false); });
  };
  const organization = activeAccount()?.organizationName ?? null;
  return (
    <Modal title="Invite someone" open onClose={onClose}>
      <Col gap={20}>
        <ModalText>{organization === null ? 'They get an email with a link to join.' : `They get an email with a link to join ${organization}.`}</ModalText>
        <FormField label="Email address" name="email" value={email} dark={dark} placeholder="name@company.com" disabled={busy} onChangeText={setEmail} onSubmit={send} inputProps={NO_ASSIST} />
        <Col gap={8}>
          <Choice<Role> label="Role" value={role} options={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]} onChange={setRole} />
          <Text size="xs" role="secondary">{ROLES_NOTE}</Text>
        </Col>
        {sent === null ? null : <Text size="md" role="success">{`An invitation went to ${sent}.`}</Text>}
        <Actions error={error} cancel={{ label: sent === null ? 'Cancel' : 'Done', onPress: onClose, disabled: busy }} main={{ label: busy ? 'Sending…' : 'Send invite', busy, disabled: email.trim() === '', onPress: send }} />
      </Col>
    </Modal>
  );
}

export function InviteButton({ compact = false }: { compact?: boolean }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const palette = useKitPalette();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="md" color="secondary" dark={dark} label={compact ? 'Invite' : 'Invite someone'} iconStart={<Icon name="userAdd" size={ICON_SIZE.md} color={palette.link} />} onPress={() => { setOpen(true); }} />
      {open ? <InviteModal onClose={() => { setOpen(false); }} /> : null}
    </>
  );
}
