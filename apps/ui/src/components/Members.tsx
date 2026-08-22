import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import {
  useKitPalette,
  useKitScheme,
} from '@stage-labs/kit/react-native/theme-context';
import { useQueryClient } from '@tanstack/react-query';
import { Text, Button } from './ui';
import { SHRINK } from '../theme';
import { PageTitle } from './PageTitle';
import { CountBadge } from './CountBadge';
import { KebabMenu } from './KebabMenu';
import { Loading } from './Loading';
import { AddMembers } from './AddMembers';
import { removeMember, setMemberRole, type Member } from '../api/projects';
import { queryError, refreshProjects, useMembersQuery } from '../api/queries';
import { useDocumentTitle } from '../title';

const ROW_PAD_Y = 12;

function MemberRow({
  member,
  busy,
  onRole,
  onRemove,
}: {
  member: Member;
  busy: boolean;
  onRole: (role: 'admin' | 'member') => void;
  onRemove: () => void;
}): ReactNode {
  const palette = useKitPalette();
  const next = member.role === 'admin' ? 'member' : 'admin';
  return (
    <Row
      justify="between"
      align="center"
      gap={12}
      padding={{ y: ROW_PAD_Y }}
      border={{ bottom: { width: 1, color: palette.border } }}
    >
      <Row gap={10} align="center" flex={1} minWidth={0}>
        <Text size="lg" weight="semibold" numberOfLines={1}>
          {member.email}
        </Text>
        <Text size="sm" role="secondary" numberOfLines={1} style={SHRINK}>
          {member.owner ? 'owner' : member.role}
        </Text>
      </Row>
      {member.owner ? null : (
        <KebabMenu
          label={`Actions for ${member.email}`}
          size="lg"
          items={[
            {
              label: busy ? 'Working…' : `Make ${next}`,
              onSelect: () => {
                onRole(next);
              },
            },
            { label: 'Remove', danger: true, onSelect: onRemove },
          ]}
        />
      )}
    </Row>
  );
}

export function Members({
  token,
  project,
}: {
  token: string;
  project: string;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const { data, error } = useMembersQuery(token, project);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useDocumentTitle('Members');

  const run = (work: Promise<unknown>, fallback: string): void => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    work
      .then(() => {
        refreshProjects(client, project);
      })
      .catch((err: unknown) => {
        setFailed(queryError(err, fallback));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const members = data ?? [];

  return (
    <Col gap={16}>
      <Row justify="between" align="center" gap={12} wrap>
        <Row gap={10} align="center">
          <PageTitle>Members</PageTitle>
          {data === undefined ? null : (
            <CountBadge count={members.length} beside="title" />
          )}
        </Row>
        <Button
          color="primary"
          dark={dark}
          label="Add members"
          onPress={() => {
            setAdding(true);
          }}
        />
      </Row>
      {error === null ? null : (
        <Text size="sm" role="danger">
          {queryError(error, 'Could not load the members.')}
        </Text>
      )}
      {failed === null ? null : (
        <Text size="sm" role="danger">
          {failed}
        </Text>
      )}
      {data === undefined && error === null ? <Loading /> : null}
      <Col>
        {members.map((member) => (
          <MemberRow
            key={member.id}
            member={member}
            busy={busy}
            onRole={(role) => {
              run(
                setMemberRole(token, project, member.id, role),
                'Could not change that role.',
              );
            }}
            onRemove={() => {
              run(
                removeMember(token, project, member.id),
                'Could not remove that member.',
              );
            }}
          />
        ))}
      </Col>
      <AddMembers
        token={token}
        project={project}
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
        onAdded={() => {
          refreshProjects(client, project);
        }}
      />
    </Col>
  );
}
