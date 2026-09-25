import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button, Text } from './ui.js';
import { Loading } from './Loading.js';
import { ListHeader } from './ListHeader.js';
import { NameModal } from './NameModal.js';
import { DeleteMenu } from './DeleteMenu.js';
import { ListRow } from './ListRow.js';
import { EmptyCard, SettingsGroup } from './SettingsSection.js';
import { routeHash } from '../route.js';
import { whenLabel } from '../api/when.js';
import { createClaudeSkill, deleteClaudeSkill, type ClaudeSkill, type SkillListing } from '../api/claude.js';
import { queryError, refreshClaudeSkills, useClaudeSkillsQuery } from '../api/queries.js';
import { useDocumentTitle } from '../title.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NAME_HELP = 'A skill name is lowercase letters, digits and dashes, like write-as-less.';

function SkillRow({ skill, project, onOpen }: { skill: ClaudeSkill; project: string; onOpen: () => void }): ReactNode {
  const client = useQueryClient();
  return (
    <ListRow
      title={skill.title}
      detail={skill.updatedAt === null ? '' : whenLabel(skill.updatedAt)}
      href={routeHash({ kind: 'skill', project, id: skill.id })}
      onOpen={onOpen}
      trailing={
        <DeleteMenu
          label={`Actions for ${skill.name}`}
          items={[{ label: 'Edit', onSelect: onOpen }]}
          item="Delete"
          action="Delete skill"
          title="Delete skill"
          lines={["This removes the skill's folder on that machine, and everything in it.", 'Claude Code stops loading it at once.']}
          word={skill.name}
          failure="Could not delete that skill."
          run={async () => {
            await deleteClaudeSkill(skill.id);
            await refreshClaudeSkills(client);
          }}
        />
      }
    />
  );
}

interface ListingProps {
  error: unknown;
  data: SkillListing | undefined;
  project: string;
  onOpen: (id: string) => void;
}

function Listing({ error, data, project, onOpen }: ListingProps): ReactNode {
  if (error !== null) return <Text size="sm" role="danger">{queryError(error, 'Could not read the skills on this machine.')}</Text>;
  if (data === undefined) return <Loading />;
  if (data.skills.length === 0) return <EmptyCard text="No skill yet. A skill teaches your agent how to do a task your way." />;
  return (
    <SettingsGroup>
      {data.skills.map((skill) => (
        <SkillRow
          key={skill.id}
          skill={skill}
          project={project}
          onOpen={() => {
            onOpen(skill.id);
          }}
        />
      ))}
    </SettingsGroup>
  );
}

export function Skills({ project, onOpen }: { project: string; onOpen: (id: string) => void }): ReactNode {
  const client = useQueryClient();
  const { data, error } = useClaudeSkillsQuery();
  const dark = useKitScheme() === 'dark';
  const [naming, setNaming] = useState(false);
  useDocumentTitle('Skills');

  return (
    <Col gap={16}>
      <ListHeader
        title="Skills"
        count={data?.skills.length}
        action={
          <Button
            color="primary"
            dark={dark}
            label="New skill"
            onPress={() => {
              setNaming(true);
            }}
          />
        }
      />
      <Listing error={error} data={data} project={project} onOpen={onOpen} />
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
          const made = await createClaudeSkill(name);
          await refreshClaudeSkills(client);
          onOpen(made.id);
          return made.id;
        }}
      />
    </Col>
  );
}
