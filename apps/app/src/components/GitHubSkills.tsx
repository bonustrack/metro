import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Button } from '@stage-labs/kit/react-native/button';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { changeSkillSource, type GitHubSkillSource } from '@metro-labs/client/api/skill-source';
import { githubCommitUrl } from '@metro-labs/client/api/github-skill';
import { whenLabel } from '@metro-labs/client/api/when';
import { queryError, refreshClaudeSkills } from '../lib/queries.js';
import { DeleteMenu } from './DeleteMenu.js';
import { GitHubSourceEditor } from './GitHubSourceEditor.js';
import { SettingsSection } from './SettingsSection.js';
import { TextLink } from './TextLink.js';

function PendingSource({ view }: { view: GitHubSkillSource }): ReactNode {
  if (!view.pending) return null;
  const staged = view.prepared?.source;
  const note = staged == null ? 'Removal is waiting for the Agent SDK.' : `Staged ${staged.commit.slice(0, 12)}.`;
  return <Text size="2xs">{note} Changes load at a safe turn, after calls, tools and workers finish. A stopped or older runner needs to be started on the new version.</Text>;
}

function SourceStatus({ view }: { view: GitHubSkillSource }): ReactNode {
  const loaded = view.loaded;
  const url = githubCommitUrl(loaded);
  return (
    <Col gap={8}>
      {view.source === null ? null : <Col gap={4}>
        <Text size="md" weight="semibold">{view.source.repository}</Text>
        <Text size="2xs" role="secondary">{view.source.ref} · {view.source.folder || 'repository root'}</Text>
      </Col>}
      <Text size="2xs" role="secondary">{view.checking ? 'Checking GitHub…' : view.checkedAt === null ? 'Not checked yet.' : `Last checked ${whenLabel(view.checkedAt)}.`}</Text>
      <PendingSource view={view} />
      {loaded === null || url === null ? null : <TextLink url={url}>Last loaded: {loaded.repository}@{loaded.commit.slice(0, 12)}</TextLink>}
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
      <Row gap={12} align="center" wrap>
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
  const dark = useKitScheme() === 'dark';
  const [editing, setEditing] = useState(false);
  return (
    <SettingsSection title="GitHub skills" note={view === undefined ? 'Update Metro on this box to connect a private skills repository.' : 'One optional source. Checked about once a minute. Local skills stay editable and take priority.'}>
      {view === undefined ? null : (
        <Col gap={16}>
          {!view.supported ? <Text size="2xs">GitHub sync needs the Agent SDK runner. The Claude Code runner and separate CLI jobs do not load this source. Local skills are unchanged.</Text> : null}
          <SourceStatus view={view} />
          {view.supported ? <Row><Button dark={dark} label={view.source === null ? 'Add GitHub sync' : 'Edit GitHub sync'} disabled={view.checking} onPress={() => { setEditing(true); }} /></Row> : null}
          {removableSource(view) ? <SourceActions view={view} /> : null}
          {editing && view.supported ? <GitHubSourceEditor view={view} onClose={() => { setEditing(false); }} /> : null}
        </Col>
      )}
    </SettingsSection>
  );
}
