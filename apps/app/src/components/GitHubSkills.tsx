import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Button } from '@stage-labs/kit/react-native/button';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { changeSkillSource, type GitHubSkillSource } from '@metro-labs/client/api/skill-source';
import { whenLabel } from '@metro-labs/client/api/when';
import { queryError, refreshClaudeSkills } from '../lib/queries.js';
import { DeleteMenu } from './DeleteMenu.js';
import { FormField } from './FormField.js';
import { SaveField, useSave } from './SaveField.js';
import { SettingsSection } from './SettingsSection.js';
import { TextLink } from './TextLink.js';

const INPUT = { autoCapitalize: 'none', autoCorrect: false, autoComplete: 'off' } as const;
const TRUST = 'Repository writers can change your agent’s instructions. Connect only a repository you trust. Sync never runs its scripts, but the agent can use them later under its normal permissions. This is not a sandbox.';
const FORMAT = 'Choose a folder containing skill-name/SKILL.md and its resources. Each name must match its folder. Hooks, tool grants, model overrides and shell substitutions are not imported. Local skills stay editable and win name conflicts.';

function SourceForm({ view }: { view: GitHubSkillSource }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [repository, setRepository] = useState(view.source?.repository ?? '');
  const [ref, setRef] = useState(view.source?.ref ?? 'main');
  const [folder, setFolder] = useState(view.source?.folder ?? 'skills');
  const saving = useSave({
    initial: '', valid: (token) => token !== '' && repository.trim() !== '' && ref.trim() !== '',
    failure: 'Could not connect the skills repository.',
    run: async (token) => {
      try {
        await changeSkillSource('PUT', { repository: repository.trim(), ref: ref.trim(), folder: folder.trim(), token });
        await refreshClaudeSkills(client);
      } finally { saving.setValue(''); }
    },
  });
  return (
    <Col gap={12}>
      <Text size="2xs" role="secondary">Only a box administrator can connect a source. Use a fine-grained token for this repository only, with Contents read-only and an expiry. GitHub may require organization approval. The token stays on the daemon, outside the agent’s files and exports.</Text>
      <TextLink url="https://github.com/settings/personal-access-tokens/new">Create a fine-grained GitHub token</TextLink>
      <FormField label="Repository" name="github-skills-repository" value={repository} onChangeText={setRepository} placeholder="organization/skills" dark={dark} disabled={saving.busy} inputProps={INPUT} />
      <FormField label="Branch, tag or commit SHA" name="github-skills-ref" value={ref} onChangeText={setRef} dark={dark} disabled={saving.busy} inputProps={INPUT} />
      <FormField label="Skills folder, empty for repository root" name="github-skills-folder" value={folder} onChangeText={setFolder} dark={dark} disabled={saving.busy} inputProps={INPUT} />
      <SaveField saving={saving} name="github-skills-token" label="Read-only token" placeholder={view.source === null ? 'github_pat_…' : 'paste a token to reconnect or change source'} secret />
    </Col>
  );
}

function PendingSource({ view }: { view: GitHubSkillSource }): ReactNode {
  if (!view.pending) return null;
  const staged = view.prepared?.source;
  const note = staged == null ? 'Removal is waiting for the Agent SDK.' : `Staged ${staged.commit.slice(0, 12)}.`;
  return <Text size="2xs">{note} Changes load at a safe turn, after calls, tools and workers finish. A stopped or older runner needs to be started on the new version.</Text>;
}

function SourceStatus({ view }: { view: GitHubSkillSource }): ReactNode {
  const loaded = view.loaded;
  return (
    <Col gap={8}>
      {view.source === null ? null : <Text size="2xs">{view.source.repository} · {view.source.ref} · {view.source.folder || 'repository root'}</Text>}
      <Text size="2xs" role="secondary">{view.checking ? 'Checking GitHub…' : view.checkedAt === null ? 'Not checked yet.' : `Last checked ${whenLabel(view.checkedAt)}.`}</Text>
      <PendingSource view={view} />
      {loaded === null ? null : <TextLink url={`https://github.com/${loaded.repository}/commit/${loaded.commit}`}>Last loaded: {loaded.repository}@{loaded.commit.slice(0, 12)}</TextLink>}
      {view.activation.shadowed.length === 0 ? null : <Text size="2xs" role="secondary">Local skills take priority: {view.activation.shadowed.join(', ')}.</Text>}
      {[view.problem, view.activation.problem].filter((note) => note !== null).map((note) => <Text key={note} size="2xs" role="danger">{note}</Text>)}
    </Col>
  );
}

function SourceActions({ view }: { view: GitHubSkillSource }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sync = (): void => {
    setBusy(true);
    setError(null);
    changeSkillSource('POST').then(() => refreshClaudeSkills(client)).catch((err: unknown) => {
      setError(queryError(err, 'Could not sync the skills.'));
    }).finally(() => { setBusy(false); });
  };
  return (
    <Col gap={8}>
      <Row gap={12} align="center">
        {view.source === null ? null : <Button dark={dark} label="Sync now" disabled={busy || view.checking || !view.supported} loading={busy} onPress={sync} />}
        <DeleteMenu label="Remove GitHub source" item="Remove" action="Remove source" title="Remove GitHub source" word={view.source?.repository ?? 'remove'}
          lines={['The token is forgotten now. Only managed skills are removed at the next safe SDK turn. Local skills stay.', 'Instructions already read can remain in the conversation. Removing the source does not revoke the token at GitHub.']}
          failure="Could not remove the skills source." run={async () => { await changeSkillSource('DELETE'); await refreshClaudeSkills(client); }} />
      </Row>
      {error === null ? null : <Text size="2xs" role="danger">{error}</Text>}
    </Col>
  );
}

const removableSource = (view: GitHubSkillSource): boolean => view.source !== null || view.loaded !== null || view.pending;

export function GitHubSkills({ view }: { view: GitHubSkillSource | undefined }): ReactNode {
  return (
    <SettingsSection title="GitHub skills" note={view === undefined ? 'Update Metro on this box to connect a private skills repository.' : 'One optional source. Checked about once a minute. Existing local skills stay on this machine.'}>
      {view === undefined ? null : (
        <Col gap={16}>
          <Text size="2xs" role="secondary">{TRUST}</Text>
          <Text size="2xs" role="secondary">{FORMAT}</Text>
          {!view.supported ? <Text size="2xs">GitHub sync needs the Agent SDK runner. The Claude Code runner and separate CLI jobs do not load this source. Local skills are unchanged.</Text> : null}
          <SourceStatus view={view} />
          {removableSource(view) ? <SourceActions view={view} /> : null}
          {view.supported ? <SourceForm key={`${view.source?.repository}/${view.source?.ref}/${view.source?.folder}`} view={view} /> : null}
        </Col>
      )}
    </SettingsSection>
  );
}
