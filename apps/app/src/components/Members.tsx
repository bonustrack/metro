import { type ReactNode, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Column } from '@stage-labs/kit/react-native/column';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { fetchOrganization, inviteMember, removeMember, setMemberRole, type Member, type Organization, type Role } from '@metro-labs/client/api/organization';
import { AgentAvatar } from './AgentAvatar.js';
import { Choice } from './Choice.js';
import type { MenuItem } from './Dropdown.js';
import { FormField } from './FormField.js';
import { Icon } from './Icon.js';
import { Modal, ModalText } from './Modal.js';
import { Actions } from './ui/Actions.js';
import { ErrorState } from './ui/ErrorState.js';
import { Group } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { RowsSkeleton, SkeletonBlock } from './ui/RowsSkeleton.js';
import { ValueMenu } from './ValueMenu.js';
import { orgKey, queryError } from '../lib/queries.js';
import { providerWords, useSignInOptions } from '../lib/sign-in-options.js';
import { AVATAR_SIZE, ICON_SIZE } from './ui/sizes.js';

const ADD_ROLES_NOTE = 'Admins launch agents, add connectors, change models and add members. Members check on agents and approve.';
const BUTTON_HEIGHT = 40;
const BUTTON_WIDTH = { full: 150, compact: 120 } as const;
const NO_ASSIST = { autoCapitalize: 'none', autoCorrect: false, spellCheck: false, autoComplete: 'off' } as const;
const ROLE_WORD: Record<Role, string> = { admin: 'Admin', member: 'Member' };

const organizationKey = (): string[] => orgKey('organization');

function useOrganizationQuery(): UseQueryResult<Organization> {
  return useQuery({ queryKey: organizationKey(), queryFn: () => fetchOrganization(), staleTime: 30_000 });
}

function useRun(onError: (text: string) => void, failure: string): (work: Promise<void>) => void {
  const client = useQueryClient();
  return (work) => {
    work.then(() => client.invalidateQueries({ queryKey: organizationKey() })).catch((err: unknown) => { onError(queryError(err, failure)); });
  };
}

function RoleMenu({ member, self, onError }: { member: Member; self: boolean; onError: (text: string) => void }): ReactNode {
  const run = useRun(onError, 'Could not change that member.');
  const items: MenuItem[] = [
    ...(['admin', 'member'] as const).map((role): MenuItem => ({ label: ROLE_WORD[role], selected: member.role === role, onSelect: () => { if (member.role !== role) run(setMemberRole(member.membershipId, role)); } })),
    ...(self ? [] : [{ label: 'Remove from the organization', danger: true, onSelect: () => { run(removeMember(member.membershipId)); } }]),
  ];
  return <ValueMenu items={items} label={`Role of ${member.email ?? member.userId}`} value={ROLE_WORD[member.role]} />;
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
    <Group label="Members" note={ADD_ROLES_NOTE} error={failed}>
      {data.members.map((m) => <MemberRow key={m.membershipId} member={m} org={data} onError={setFailed} />)}
    </Group>
  );
}

interface InviteWords {
  title: string;
  note: string;
  roles: string;
  done: (email: string) => string;
  send: string;
  sending: string;
  failure: string;
}

function inviteWords(providers: string): InviteWords {
  return {
    title: 'Add member',
    note: `Metro sends no email, so ask them to sign in at https://metro.box with ${providers} using this email address.`,
    roles: ADD_ROLES_NOTE,
    done: (email) => `${email} is a member now. Ask them to sign in at https://metro.box with ${providers} using ${email}.`,
    send: 'Add member',
    sending: 'Adding…',
    failure: 'Could not add that person.',
  };
}

function InviteModal({ words, onClose }: { words: InviteWords; onClose: () => void }): ReactNode {
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
      .catch((err: unknown) => { setError(queryError(err, words.failure)); })
      .finally(() => { setBusy(false); });
  };
  return (
    <Modal title={words.title} open onClose={onClose}>
      <Column gap={20}>
        <ModalText>{words.note}</ModalText>
        <FormField label="Email address" name="email" value={email} placeholder="name@company.com" disabled={busy} onChangeText={setEmail} onSubmit={send} inputProps={NO_ASSIST} />
        <Column gap={8}>
          <Choice<Role> label="Role" value={role} options={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]} onChange={setRole} />
          <Text size="xs" color="secondary">{words.roles}</Text>
        </Column>
        {sent === null ? null : <Text size="md" color="success">{words.done(sent)}</Text>}
        <Actions error={error} cancel={{ label: sent === null ? 'Cancel' : 'Done', onPress: onClose, disabled: busy }} main={{ label: busy ? words.sending : words.send, busy, disabled: email.trim() === '', onPress: send }} />
      </Column>
    </Modal>
  );
}

export function InviteButton({ compact = false }: { compact?: boolean }): ReactNode {
  const palette = useKitPalette();
  const options = useSignInOptions();
  const [open, setOpen] = useState(false);
  if (options === null) return <SkeletonBlock width={compact ? BUTTON_WIDTH.compact : BUTTON_WIDTH.full} height={BUTTON_HEIGHT} radius={BUTTON_HEIGHT / 2} />;
  return (
    <>
      <Button size="md" color="secondary" label="Add member" iconStart={<Icon name="userAdd" size={ICON_SIZE.md} color={palette.link} />} onPress={() => { setOpen(true); }} />
      {open ? <InviteModal words={inviteWords(providerWords(options.providers))} onClose={() => { setOpen(false); }} /> : null}
    </>
  );
}
