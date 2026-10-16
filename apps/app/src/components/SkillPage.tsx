import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { githubSkillUrl } from '@metro-labs/client/api/github-skill';
import { routeHash } from '@metro-labs/client/route';
import { whenLabel } from '@metro-labs/client/api/when';
import { deleteClaudeSkill, saveClaudeSkill, type ClaudeSkill } from '@metro-labs/client/api/claude';
import { DeleteMenu } from './DeleteMenu.js';
import { FormField } from './FormField.js';
import { GitHubMark } from './GitHubMark.js';
import { Group, Rows } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { AgentDeepPage } from './agent/AgentDeepPage.js';
import { ErrorState } from './ui/ErrorState.js';
import { RowsSkeleton } from './ui/RowsSkeleton.js';
import { ICON_SIZE } from './ui/sizes.js';
import { GROW } from '../lib/style.js';
import { go } from '../lib/nav.js';
import { openExternal } from '../lib/open.js';
import { queryError, refreshClaudeSkills, useClaudeSkillQuery } from '../lib/queries.js';
import { useDocumentTitle } from '../lib/title.js';

const EDITOR = { minHeight: 420, lineHeight: 22 } as const;
const NO_ASSIST = { multiline: true, autoCapitalize: 'none', autoCorrect: false, spellCheck: false } as const;
const SAVED = 'Saved. The next Claude Code session on this machine reads it.';

function Managed({ skill }: { skill: ClaudeSkill }): ReactNode {
  const palette = useKitPalette();
  const url = githubSkillUrl(skill);
  if (skill.managed !== true) return skill.editable ? null : <Text size="xs" role="secondary">This skill is too large to edit here.</Text>;
  return (
    <Rows>
      <Item
        title="From GitHub, read-only"
        subtitle={`Edit the repository, not this copy.${skill.shadowed === true ? ' A local skill with this name takes priority.' : ''}`}
        leading={<GitHubMark size={ICON_SIZE.md} color={palette.text} />}
        onPress={url === null ? undefined : () => { openExternal(url); }}
      />
    </Rows>
  );
}

const skillFacts = (skill: ClaudeSkill): string | undefined =>
  [skill.description, skill.updatedAt === null ? '' : `Changed ${whenLabel(skill.updatedAt)}.`].filter((part) => part !== '').join(' ') || undefined;

function DeleteSkill({ skill, project, edit }: { skill: ClaudeSkill; project: string; edit: Editing }): ReactNode {
  const client = useQueryClient();
  if (skill.managed === true) return null;
  return (
    <DeleteMenu
      label={`Actions for ${skill.name}`}
      items={edit.changed ? [{ label: 'Revert changes', onSelect: edit.revert }] : []}
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
      onDone={() => {
        go({ kind: 'skills', project });
      }}
    />
  );
}

function SaveButton({ edit }: { edit: Editing }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return <Button size="md" color="secondary" dark={dark} label={edit.busy ? 'Saving…' : 'Save'} loading={edit.busy} disabled={edit.busy || !edit.changed} onPress={edit.save} />;
}

function HeaderActions({ skill, project, edit }: { skill: ClaudeSkill; project: string; edit: Editing }): ReactNode {
  if (skill.managed === true) return null;
  return (
    <Row gap={12} align="center">
      {skill.editable ? <SaveButton edit={edit} /> : null}
      <DeleteSkill skill={skill} project={project} edit={edit} />
    </Row>
  );
}

interface SkillPageProps {
  project: string;
  id: string;
}

interface Editing {
  shown: string;
  changed: boolean;
  busy: boolean;
  note: string | null;
  failure: string | null;
  setDraft: (text: string) => void;
  save: () => void;
  revert: () => void;
}

function useSkillEditor(skill: (ClaudeSkill & { text: string }) | undefined): Editing {
  const client = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const save = (): void => {
    if (skill === undefined || draft === null) return;
    setBusy(true);
    setFailure(null);
    setNote(null);
    saveClaudeSkill(skill.id, draft, skill.updatedAt)
      .then(() => refreshClaudeSkills(client, skill.id))
      .then(() => {
        setDraft(null);
        setNote(SAVED);
      })
      .catch((err: unknown) => {
        setFailure(queryError(err, 'Could not save that skill.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return {
    shown: draft ?? skill?.text ?? '',
    changed: draft !== null && skill?.editable === true,
    busy,
    note,
    failure,
    setDraft,
    save,
    revert: () => {
      setDraft(null);
      setNote(null);
    },
  };
}

function SkillBody({ skill, edit }: { skill: ClaudeSkill; edit: Editing }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={20}>
      <Managed skill={skill} />
      <Group wide note={edit.note ?? undefined} error={edit.failure}>
        <FormField label="Skill contents"
          name="skill"
          value={edit.shown}
          dark={dark}
          disabled={edit.busy || !skill.editable}
          onChangeText={edit.setDraft}
          style={[GROW, EDITOR]}
          inputProps={NO_ASSIST}
        />
      </Group>
    </Col>
  );
}

export function SkillPage({ project, id }: SkillPageProps): ReactNode {
  const { data, error, refetch } = useClaudeSkillQuery(id);
  const edit = useSkillEditor(data);
  const title = data?.title ?? 'Skill';
  useDocumentTitle(title);
  return (
    <AgentDeepPage
      project={project}
      tab="memory"
      trail={[{ label: 'Skills', href: routeHash({ kind: 'skills', project }) }, { label: title }]}
      title={title}
      subtitle={data === undefined ? undefined : skillFacts(data)}
      action={data === undefined ? undefined : <HeaderActions skill={data} project={project} edit={edit} />}
    >
      {data === undefined ? (
        error === null ? <RowsSkeleton rows={3} leading={false} trailing={false} /> : <ErrorState title="Could not read that skill" text={queryError(error, 'The agent did not answer.')} onRetry={refetch} />
      ) : (
        <SkillBody skill={data} edit={edit} />
      )}
    </AgentDeepPage>
  );
}
