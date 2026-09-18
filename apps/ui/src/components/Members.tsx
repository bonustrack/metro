import { type ReactNode, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Text, Button, Input } from './ui.js';
import { PageTitle } from './PageTitle.js';
import { Pill } from './Pill.js';
import { KebabMenu } from './KebabMenu.js';
import { Loading } from './Loading.js';
import { Frame } from './Frame.js';
import { PlainSidebar } from './PlainSidebar.js';
import { AgentAvatar } from './AgentAvatar.js';
import { fetchOrganization, inviteMember, removeMember, revokeInvitation, setMemberRole, type Invitation, type Member, type Organization, type Role } from '../api/organization.js';
import { queryError } from '../api/queries.js';
import { activeAccount } from '../auth/account.js';
import { routeHash } from '../route.js';
import { useDocumentTitle } from '../title.js';
import { GROW, SHRINK } from '../theme.js';

const LIST_WIDTH = 640;
const AVATAR = 32;
const HOW = 'Everyone here opens every agent of the organization. Admins can also stop, restart, update and reset agents, open the terminal and manage members.';
const NO_ASSIST = { autoCapitalize: 'none', autoCorrect: false, spellCheck: false, autoComplete: 'off' } as const;

const organizationKey = (): string[] => ['organization'];

function useOrganizationQuery(): UseQueryResult<Organization> {
  return useQuery({ queryKey: organizationKey(), queryFn: () => fetchOrganization(), staleTime: 30_000 });
}

interface Action {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

function memberActions(member: Member, self: boolean, run: (work: Promise<void>) => void): Action[] {
  const other: Role = member.role === 'admin' ? 'member' : 'admin';
  const actions: Action[] = [{ label: other === 'admin' ? 'Make admin' : 'Make member', onSelect: () => { run(setMemberRole(member.membershipId, other)); } }];
  if (!self) actions.push({ label: 'Remove', danger: true, onSelect: () => { run(removeMember(member.membershipId)); } });
  return actions;
}

const memberLabel = (member: Member, self: boolean): string => `${member.name ?? member.email ?? member.userId}${self ? ' (you)' : ''}`;

function MemberRow({ member, org, last, onError }: { member: Member; org: Organization; last: boolean; onError: (text: string) => void }): ReactNode {
  const palette = useKitPalette();
  const client = useQueryClient();
  const self = member.userId === org.self;
  const run = (work: Promise<void>): void => {
    work.then(() => client.invalidateQueries({ queryKey: organizationKey() })).catch((err: unknown) => {
      onError(queryError(err, 'Could not change that member.'));
    });
  };
  return (
    <Row align="center" gap={12} padding={{ x: 14, y: 12 }} border={last ? undefined : { bottom: { width: 1, color: palette.border } }}>
      <AgentAvatar seed={member.userId} src={member.picture} size={AVATAR} />
      <Col style={GROW}>
        <Text size="md" weight="semibold" numberOfLines={1}>
          {memberLabel(member, self)}
        </Text>
        {member.name === null || member.email === null ? null : (
          <Text size="sm" role="secondary" numberOfLines={1} style={SHRINK}>
            {member.email}
          </Text>
        )}
      </Col>
      <Pill label={member.role === 'admin' ? 'Admin' : 'Member'} variant={member.role === 'admin' ? 'primary' : 'default'} />
      {org.role === 'admin' ? <KebabMenu label={`Actions for ${member.email ?? member.userId}`} items={memberActions(member, self, run)} /> : null}
    </Row>
  );
}

function InvitationRow({ invitation, org, last, onError }: { invitation: Invitation; org: Organization; last: boolean; onError: (text: string) => void }): ReactNode {
  const palette = useKitPalette();
  const client = useQueryClient();
  const revoke = (): void => {
    revokeInvitation(invitation.id)
      .then(() => client.invalidateQueries({ queryKey: organizationKey() }))
      .catch((err: unknown) => {
        onError(queryError(err, 'Could not revoke that invitation.'));
      });
  };
  return (
    <Row align="center" gap={12} padding={{ x: 14, y: 12 }} border={last ? undefined : { bottom: { width: 1, color: palette.border } }}>
      <Col style={GROW}>
        <Text size="md" numberOfLines={1}>{invitation.email}</Text>
        <Text size="sm" role="secondary">Invited{invitation.role === null ? '' : ` as ${invitation.role}`}, not accepted yet</Text>
      </Col>
      {org.role === 'admin' ? <KebabMenu label={`Actions for the invitation of ${invitation.email}`} items={[{ label: 'Revoke', danger: true, onSelect: revoke }]} /> : null}
    </Row>
  );
}

function Invite({ onError }: { onError: (text: string) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const send = (): void => {
    if (busy || email.trim() === '') return;
    setBusy(true);
    setSent(null);
    inviteMember(email.trim(), role)
      .then(async () => {
        setSent(email.trim());
        setEmail('');
        await client.invalidateQueries({ queryKey: organizationKey() });
      })
      .catch((err: unknown) => {
        onError(queryError(err, 'Could not send the invitation.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Col gap={10}>
      <Text size="md" weight="semibold">Invite someone</Text>
      <Row gap={8} align="center" wrap>
        <Input name="email" value={email} dark={dark} placeholder="name@company.com" disabled={busy} onChangeText={setEmail} style={GROW} inputProps={NO_ASSIST} />
        <Button size="sm" color={role === 'member' ? 'primary' : 'secondary'} dark={dark} label="Member" onPress={() => { setRole('member'); }} />
        <Button size="sm" color={role === 'admin' ? 'primary' : 'secondary'} dark={dark} label="Admin" onPress={() => { setRole('admin'); }} />
        <Button color="primary" dark={dark} label={busy ? 'Sending…' : 'Invite'} loading={busy} disabled={busy || email.trim() === ''} onPress={send} />
      </Row>
      {sent === null ? null : <Text size="sm" role="secondary">{`An invitation went to ${sent}.`}</Text>}
    </Col>
  );
}

function Body(): ReactNode {
  const palette = useKitPalette();
  const { data, error, isPending } = useOrganizationQuery();
  const [failed, setFailed] = useState<string | null>(null);
  if (isPending) return <Loading />;
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, 'Could not read the organization.')}</Text>;
  const side = { width: 1, color: palette.border };
  return (
    <Col gap={20}>
      <Col radius={BLOCK_RADIUS_DEFAULT} border={{ top: side, right: side, bottom: side, left: side }}>
        {data.members.map((m, i) => (
          <MemberRow key={m.membershipId} member={m} org={data} last={i === data.members.length - 1 && data.invitations.length === 0} onError={setFailed} />
        ))}
        {data.invitations.map((inv, i) => (
          <InvitationRow key={inv.id} invitation={inv} org={data} last={i === data.invitations.length - 1} onError={setFailed} />
        ))}
      </Col>
      {failed === null ? null : <Text size="sm" role="danger">{failed}</Text>}
      {data.role === 'admin' ? <Invite onError={setFailed} /> : null}
    </Col>
  );
}

export function Members({ onLock }: { onLock: () => void }): ReactNode {
  const subject = activeAccount()?.user.id ?? '';
  const name = activeAccount()?.organizationName ?? 'Members';
  useDocumentTitle('Members');
  return (
    <Frame
      selection={{ kind: 'members' }}
      sidebar={(closeMenu) => (
        <PlainSidebar
          selection={{ kind: 'members' }}
          subject={subject}
          onSelect={(next) => {
            closeMenu();
            window.location.hash = routeHash(next);
          }}
          onLock={onLock}
        />
      )}
    >
      <Col gap={20} width="100%" maxWidth={LIST_WIDTH}>
        <PageTitle>{name}</PageTitle>
        <Text size="sm" role="secondary">{HOW}</Text>
        <Body />
      </Col>
    </Frame>
  );
}
