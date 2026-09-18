import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button, Text } from './ui.js';
import { Loading } from './Loading.js';
import { ListHeader } from './ListHeader.js';
import { NameModal } from './NameModal.js';
import { KebabMenu } from './KebabMenu.js';
import { ConfirmModal } from './ConfirmModal.js';
import { ListRow } from './ListRow.js';
import { routeHash } from '../route.js';
import { whenLabel } from '../api/when.js';
import { createClaudeSkill, deleteClaudeSkill, type ClaudeSkill, type SkillListing } from '../api/claude.js';
import { queryError, refreshClaudeSkills, useClaudeSkillsQuery, useModeQuery } from '../api/queries.js';
import { olderThan } from '../api/version.js';
import { useDocumentTitle } from '../title.js';

const SKILLS_SINCE = '0.1.0-beta.87';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NAME_HELP = 'A skill name is lowercase letters, digits and dashes, like write-as-less.';

function SkillRow({ skill, project, onOpen, onDelete }: { skill: ClaudeSkill; project: string; onOpen: () => void; onDelete: () => void }): ReactNode {
  return (
    <ListRow
      title={skill.title}
      detail={skill.updatedAt === null ? '' : whenLabel(skill.updatedAt)}
      href={routeHash({ kind: 'skill', project, id: skill.id })}
      onOpen={onOpen}
      trailing={
        <KebabMenu
          label={`Actions for ${skill.name}`}
          size="lg"
          items={[
            { label: 'Edit', onSelect: onOpen },
            { label: 'Delete', danger: true, onSelect: onDelete },
          ]}
        />
      }
    />
  );
}

interface ListingProps {
  old: boolean;
  error: unknown;
  data: SkillListing | undefined;
  project: string;
  onOpen: (id: string) => void;
  onDelete: (skill: ClaudeSkill) => void;
}

function Listing({ old, error, data, project, onOpen, onDelete }: ListingProps): ReactNode {
  if (old)
    return (
      <Text size="sm" role="secondary">
        {`Skills need metro ${SKILLS_SINCE} or newer on this machine. Update it on the Server tab.`}
      </Text>
    );
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, 'Could not read the skills on this machine.')}</Text>;
  if (data === undefined) return <Loading />;
  if (data.skills.length === 0) return <Text size="sm" role="secondary">No skill on this machine yet.</Text>;
  return (
    <Col>
      {data.skills.map((skill) => (
        <SkillRow
          key={skill.id}
          skill={skill}
          project={project}
          onOpen={() => {
            onOpen(skill.id);
          }}
          onDelete={() => {
            onDelete(skill);
          }}
        />
      ))}
    </Col>
  );
}

export function Skills({ project, onOpen }: { project: string; onOpen: (id: string) => void }): ReactNode {
  const client = useQueryClient();
  const mode = useModeQuery();
  const old = olderThan(mode.data?.version ?? null, SKILLS_SINCE);
  const { data, error } = useClaudeSkillsQuery(!old);
  const dark = useKitScheme() === 'dark';
  const [naming, setNaming] = useState(false);
  const [dropping, setDropping] = useState<ClaudeSkill | null>(null);
  const [busy, setBusy] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  useDocumentTitle('Skills');

  const drop = (): void => {
    if (dropping === null) return;
    setBusy(true);
    setDropError(null);
    deleteClaudeSkill(dropping.id)
      .then(() => refreshClaudeSkills(client))
      .then(() => {
        setDropping(null);
      })
      .catch((err: unknown) => {
        setDropError(queryError(err, 'Could not delete that skill.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Col gap={16}>
      <ListHeader
        title="Skills"
        count={data?.skills.length}
        action={
          old ? null : (
            <Button
              color="primary"
              dark={dark}
              label="New skill"
              onPress={() => {
                setNaming(true);
              }}
            />
          )
        }
      />
      <Listing old={old} error={error} data={data} project={project} onOpen={onOpen} onDelete={setDropping} />
      <NameModal
        title="New skill"
        action="Create"
        placeholder="write-as-less"
        failure={NAME_HELP}
        open={naming}
        onClose={() => {
          setNaming(false);
        }}
        onSubmit={async (name) => {
          if (!NAME_RE.test(name)) throw new Error(NAME_HELP);
          const made = await createClaudeSkill(name, data?.places[0]?.id ?? 'user');
          await refreshClaudeSkills(client);
          onOpen(made.id);
          return made.id;
        }}
      />
      <ConfirmModal
        open={dropping !== null}
        title="Delete skill"
        lines={[
          "This removes the skill's folder on that machine, and everything in it.",
          'Claude Code stops loading it at once.',
        ]}
        prompt={`Type ${dropping?.name ?? ''} to confirm.`}
        confirmWord={dropping?.name ?? ''}
        confirmLabel="Delete skill"
        busy={busy}
        error={dropError}
        onClose={() => {
          setDropping(null);
          setDropError(null);
        }}
        onConfirm={drop}
      />
    </Col>
  );
}
