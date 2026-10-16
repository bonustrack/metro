import { type ReactNode, useState } from 'react';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { routeHash } from '@metro-labs/client/route';
import { useQueryClient } from '@tanstack/react-query';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { changeSkillSource, type GitHubSkillSource } from '@metro-labs/client/api/skill-source';
import { githubCommitUrl } from '@metro-labs/client/api/github-skill';
import { whenLabel } from '@metro-labs/client/api/when';
import { queryError, refreshClaudeSkills } from '../lib/queries.js';
import { openExternal } from '../lib/open.js';
import { ConfirmDialog, useConfirm } from './DeleteMenu.js';
import { GitHubMark } from './GitHubMark.js';
import { Group } from './ui/Group.js';
import { Item } from './ui/Item.js';

const MARK = 22;
const NOTE = 'One source, checked about once a minute. Local skills stay editable and win.';

function pendingLine(view: GitHubSkillSource): string {
  const staged = view.prepared?.source;
  const what = staged == null ? 'Removal is waiting for the agent.' : `Staged ${staged.commit.slice(0, 12)}.`;
  return `${what} Changes load at a safe turn, after calls, tools and workers finish.`;
}

function checkedLabel(view: GitHubSkillSource): string {
  if (view.checking) return 'Checking…';
  return view.checkedAt === null ? 'Not checked yet' : `Checked ${whenLabel(view.checkedAt)}`;
}

function useSync(): { busy: boolean; error: string | null; sync: () => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sync = (): void => {
    setBusy(true);
    setError(null);
    changeSkillSource('POST')
      .then(() => refreshClaudeSkills(client))
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not sync the skills.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { busy, error, sync };
}

function RemoveRow({ view }: { view: GitHubSkillSource }): ReactNode {
  const client = useQueryClient();
  const confirming = useConfirm(async () => {
    await changeSkillSource('DELETE');
    await refreshClaudeSkills(client);
  }, 'Could not remove the skills source.');
  return (
    <>
      <Item title="Remove GitHub sync" danger chevron={false} onPress={confirming.show} />
      <ConfirmDialog
        confirming={confirming}
        title="Remove GitHub sync"
        action="Remove source"
        word={view.source?.repository ?? 'remove'}
        lines={['The token is forgotten now. Synced skills go at the next safe turn. Local skills stay.', 'The agent may still remember what it read. Revoke the token at GitHub yourself.']}
      />
    </>
  );
}

function Notes({ view, extra }: { view: GitHubSkillSource; extra: string | null }): ReactNode {
  const problems = [view.problem, view.activation.problem, extra].filter((note) => note !== null);
  return (
    <>
      {view.pending ? <Item title="Changes waiting" subtitle={pendingLine(view)} /> : null}
      {problems.map((note) => <Item key={note} title="Problem" subtitle={note} subtitleTone="danger" />)}
      {view.activation.shadowed.length === 0 ? null : <Item title="Local skills take priority" subtitle={view.activation.shadowed.join(', ')} />}
    </>
  );
}

function LoadedRow({ view }: { view: GitHubSkillSource }): ReactNode {
  const url = githubCommitUrl(view.loaded);
  if (view.loaded === null || url === null) return null;
  return <Item title="Last loaded" value={`${view.loaded.repository}@${view.loaded.commit.slice(0, 12)}`} onPress={() => { openExternal(url); }} />;
}

function SourceRow({ view, edit }: { view: GitHubSkillSource; edit: string | undefined }): ReactNode {
  const palette = useKitPalette();
  if (view.source === null) return null;
  const { repository, ref, folder } = view.source;
  return <Item title={repository} subtitle={`${ref} · ${folder || 'repository root'}`} value={checkedLabel(view)} leading={<GitHubMark size={MARK} color={palette.text} />} href={edit} />;
}

function SourceRows({ view, edit }: { view: GitHubSkillSource; edit: string | undefined }): ReactNode {
  const syncing = useSync();
  const idle = !syncing.busy && !view.checking && view.supported;
  return (
    <>
      <SourceRow view={view} edit={edit} />
      <Notes view={view} extra={syncing.error} />
      {view.source === null ? null : <Item title="Sync now" subtitle="Check GitHub for changes" value={syncing.busy ? 'Syncing…' : undefined} chevron={false} onPress={idle ? syncing.sync : undefined} />}
      <LoadedRow view={view} />
      {view.source !== null || view.loaded !== null || view.pending ? <RemoveRow view={view} /> : null}
    </>
  );
}

function Rows({ view }: { view: GitHubSkillSource }): ReactNode {
  const palette = useKitPalette();
  const edit = view.supported && !view.checking ? routeHash({ kind: 'skills-github', project: currentServer()?.id ?? '' }) : undefined;
  return (
    <>
      {view.supported ? null : <Item title="Not available yet" subtitle="Update Metro on this server to use GitHub sync." />}
      {view.supported && view.source === null ? <Item title="Add GitHub sync" subtitle="Only an admin can connect a source." leading={<GitHubMark size={MARK} color={palette.text} />} href={edit} /> : null}
      <SourceRows view={view} edit={edit} />
    </>
  );
}

export function GitHubSkills({ view }: { view: GitHubSkillSource | undefined }): ReactNode {
  return (
    <Group label="GitHub skills" note={view === undefined ? undefined : NOTE}>
      {view === undefined ? <Item title="Not available yet" subtitle="Update Metro on this box to connect a private skills repository." /> : <Rows view={view} />}
    </Group>
  );
}
