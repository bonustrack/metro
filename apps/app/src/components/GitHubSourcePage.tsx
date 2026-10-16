import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { changeSkillSource, type GitHubSkillSource } from '@metro-labs/client/api/skill-source';
import { routeHash } from '@metro-labs/client/route';
import { queryError, refreshClaudeSkills, useClaudeSkillsQuery } from '../lib/queries.js';
import { go } from '../lib/nav.js';
import { useDocumentTitle } from '../lib/title.js';
import { AgentDeepPage } from './agent/AgentDeepPage.js';
import { FormField } from './FormField.js';
import { useSave } from './SaveField.js';
import { TextLink } from './TextLink.js';
import { Actions } from './ui/Actions.js';
import { ErrorState } from './ui/ErrorState.js';
import { Readable } from './ui/Layout.js';
import { RowsSkeleton } from './ui/RowsSkeleton.js';
import { StateBlock } from './ui/StateBlock.js';

const INPUT = { autoCapitalize: 'none', autoCorrect: false, autoComplete: 'off', spellCheck: false } as const;
const TRUST = 'Anyone who can write to it can change your agent’s instructions. Use a repository you trust: the agent may run its scripts.';
const FORMAT = 'A skill’s name must match its folder. Hooks, tool grants, model overrides and shell commands are skipped. Local skills win on the same name.';
const LEAD = 'Sync skills from one private GitHub repository. Only an admin can connect a source.';

function Hint({ children }: { children: string }): ReactNode {
  return (
    <Text size="xs" role="secondary">
      {children}
    </Text>
  );
}

function TokenHelp({ editing }: { editing: boolean }): ReactNode {
  return (
    <Col gap={4}>
      {editing ? <Hint>Paste a token to save changes. The stored token is never shown.</Hint> : null}
      <Hint>Use a fine-grained token for this repository, with read-only Contents and an expiry. It stays on the server, away from the agent and exports.</Hint>
      <TextLink size="xs" url="https://github.com/settings/personal-access-tokens/new">Create a fine-grained GitHub token</TextLink>
    </Col>
  );
}

function SourceForm({ project, view }: { project: string; view: GitHubSkillSource }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [repository, setRepository] = useState(view.source?.repository ?? '');
  const [ref, setRef] = useState(view.source?.ref ?? 'main');
  const [folder, setFolder] = useState(view.source?.folder ?? 'skills');
  const back = (): void => {
    go({ kind: 'skills', project });
  };
  const saving = useSave({
    initial: '',
    valid: (token) => token !== '' && repository.trim() !== '' && ref.trim() !== '',
    failure: 'Could not save the skills source.',
    run: async (token) => {
      try {
        await changeSkillSource('PUT', { repository: repository.trim(), ref: ref.trim(), folder: folder.trim(), token });
        await refreshClaudeSkills(client);
        back();
      } finally {
        saving.setValue('');
      }
    },
  });
  return (
    <Readable gap={20}>
      <FormField label="Repository" name="github-skills-repository" value={repository} onChangeText={setRepository} placeholder="organization/skills" dark={dark} disabled={saving.busy} inputProps={INPUT} />
      <FormField label="Branch, tag or commit" name="github-skills-ref" value={ref} onChangeText={setRef} dark={dark} disabled={saving.busy} inputProps={INPUT} />
      <Col gap={6}>
        <FormField label="Skills folder" name="github-skills-folder" value={folder} onChangeText={setFolder} placeholder="skills" dark={dark} disabled={saving.busy} inputProps={INPUT} />
        <Hint>The folder that holds skill-name/SKILL.md, like skills. Empty means the repository root.</Hint>
      </Col>
      <Col gap={6}>
        <FormField label="Read-only token" name="github-skills-token" value={saving.value} onChangeText={saving.setValue} placeholder="github_pat_…" inputType="password" dark={dark} disabled={saving.busy} inputProps={INPUT} onSubmit={saving.save} />
        <TokenHelp editing={view.source !== null} />
      </Col>
      <Col gap={4}>
        <Hint>{TRUST}</Hint>
        <Hint>{FORMAT}</Hint>
      </Col>
      <Actions error={saving.error} cancel={{ onPress: back, disabled: saving.busy }} main={{ label: saving.busy ? 'Saving…' : 'Save', busy: saving.busy, disabled: !saving.ready, onPress: saving.save }} />
    </Readable>
  );
}

function Body({ project }: { project: string }): ReactNode {
  const { data, error, refetch } = useClaudeSkillsQuery();
  if (error !== null) return <ErrorState title="Could not read the skills" text={queryError(error, 'Try again in a moment.')} onRetry={refetch} />;
  if (data === undefined) return <RowsSkeleton rows={4} leading={false} />;
  const view = data.skillSource;
  if (view === undefined || !view.supported) return <StateBlock icon="sparkle" title="Not available yet" text="Update Metro on this server to use GitHub sync." />;
  return <SourceForm project={project} view={view} />;
}

export function GitHubSourcePage({ project }: { project: string }): ReactNode {
  const { data } = useClaudeSkillsQuery();
  const editing = data?.skillSource?.source != null;
  const title = editing ? 'Edit GitHub sync' : 'Add GitHub sync';
  useDocumentTitle(title);
  return (
    <AgentDeepPage project={project} tab="memory" trail={[{ label: 'Skills', href: routeHash({ kind: 'skills', project }) }, { label: 'GitHub sync' }]} title={title} subtitle={LEAD}>
      <Body project={project} />
    </AgentDeepPage>
  );
}
