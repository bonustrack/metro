import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { Loading } from './Loading.js';
import { ListHeader } from './ListHeader.js';
import { NameModal } from './NameModal.js';
import { DeleteMenu } from './DeleteMenu.js';
import { ListRow } from './ListRow.js';
import { EmptyCard, SettingsGroup } from './SettingsSection.js';
import { routeHash } from '@metro-labs/client/route';
import { whenLabel } from '@metro-labs/client/api/when';
import { createClaudeSkill, deleteClaudeSkill, type ClaudeSkill, type SkillListing } from '@metro-labs/client/api/claude';
import { queryError, refreshClaudeSkills, useClaudeSkillsQuery } from '../lib/queries.js';
import { useDocumentTitle } from '../lib/title.js';
import { go } from '../lib/nav.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NAME_HELP = 'A skill name is lowercase letters, digits and dashes, like write-as-less.';

function SkillRow({ skill, project }: { skill: ClaudeSkill; project: string }): ReactNode {
  const client = useQueryClient();
  return (
    <ListRow
      title={skill.title}
      detail={skill.updatedAt === null ? '' : whenLabel(skill.updatedAt)}
      href={routeHash({ kind: 'skill', project, id: skill.id })}
      trailing={
        <DeleteMenu
          label={`Actions for ${skill.name}`}
          items={[{ label: 'Edit', onSelect: () => { go({ kind: 'skill', project, id: skill.id }); } }]}
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
}

function Listing({ error, data, project }: ListingProps): ReactNode {
  if (error !== null) return <Text size="2xs" role="danger">{queryError(error, 'Could not read the skills on this machine.')}</Text>;
  if (data === undefined) return <Loading />;
  if (data.skills.length === 0) return <EmptyCard text="No skill yet. A skill teaches your agent how to do a task your way." />;
  return (
    <SettingsGroup>
      {data.skills.map((skill) => (
        <SkillRow key={skill.id} skill={skill} project={project} />
      ))}
    </SettingsGroup>
  );
}

export function Skills({ project }: { project: string }): ReactNode {
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
      <Listing error={error} data={data} project={project} />
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
          go({ kind: 'skill', project, id: made.id });
          return made.id;
        }}
      />
    </Col>
  );
}
