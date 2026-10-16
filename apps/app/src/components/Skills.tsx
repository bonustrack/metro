import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { createClaudeSkill, type ClaudeSkill, type SkillListing } from '@metro-labs/client/api/claude';
import { whenLabel } from '@metro-labs/client/api/when';
import { routeHash } from '@metro-labs/client/route';
import { GitHubMark } from './GitHubMark.js';
import { GitHubSkills } from './GitHubSkills.js';
import { Icon } from './Icon.js';
import { NameModal } from './NameModal.js';
import { Group, Groups } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { ErrorState } from './ui/ErrorState.js';
import { RowsSkeleton } from './ui/RowsSkeleton.js';
import { ICON_SIZE } from './ui/sizes.js';
import { go } from '../lib/nav.js';
import { queryError, refreshClaudeSkills, useClaudeSkillsQuery } from '../lib/queries.js';
import { useDocumentTitle } from '../lib/title.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NAME_HELP = 'A skill name is lowercase letters, digits and dashes, like write-as-less.';
const ICON = ICON_SIZE.md;

function skillLine(skill: ClaudeSkill): string | undefined {
  if (skill.managed === true) return skill.shadowed === true ? 'From GitHub · a local skill takes priority' : 'From GitHub, read-only';
  return skill.description === '' ? undefined : skill.description;
}

function SkillRow({ skill, project }: { skill: ClaudeSkill; project: string }): ReactNode {
  const palette = useKitPalette();
  const icon = skill.managed === true ? <GitHubMark size={ICON} color={palette.text} /> : <Icon name="sparkle" size={ICON} color={palette.sub} />;
  return (
    <Item
      title={skill.title}
      subtitle={skillLine(skill)}
      value={skill.updatedAt === null ? undefined : whenLabel(skill.updatedAt)}
      leading={icon}
      href={routeHash({ kind: 'skill', project, id: skill.id })}
    />
  );
}

interface ListingProps {
  error: Error | null;
  data: SkillListing | undefined;
  project: string;
  onNew: () => void;
  onRetry: () => unknown;
}

function Listing({ error, data, project, onNew, onRetry }: ListingProps): ReactNode {
  const palette = useKitPalette();
  if (data === undefined) return error === null ? <RowsSkeleton rows={3} /> : <ErrorState title="Could not read the skills" text={queryError(error, 'The agent did not answer.')} onRetry={onRetry} />;
  return (
    <>
      {data.skills.map((skill) => <SkillRow key={skill.id} skill={skill} project={project} />)}
      <Item title="New skill" leading={<Icon name="plus" size={ICON} color={palette.link} />} chevron={false} onPress={onNew} />
    </>
  );
}

export function Skills({ project }: { project: string }): ReactNode {
  const client = useQueryClient();
  const { data, error, refetch } = useClaudeSkillsQuery();
  const [naming, setNaming] = useState(false);
  useDocumentTitle('Skills');
  return (
    <Groups>
      <Group label="Skills" note="A skill teaches the agent how to do a task your way.">
        <Listing error={error} data={data} project={project} onNew={() => { setNaming(true); }} onRetry={refetch} />
      </Group>
      {data === undefined ? null : <GitHubSkills view={data.skillSource} />}
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
    </Groups>
  );
}
