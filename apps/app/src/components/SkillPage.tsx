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
import { Loading } from './Loading.js';
import { Rows } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { Crumbs, PageHeader } from './ui/PageHeader.js';
import { StateBlock } from './ui/StateBlock.js';
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
  if (skill.managed !== true) return skill.editable ? null : <Text size="md" role="danger">That skill is too large to edit here.</Text>;
  return (
    <Rows>
      <Item
        title="From GitHub, read-only"
        subtitle={`Edit the repository, not this copy.${skill.shadowed === true ? ' A local skill with this name takes priority.' : ''}`}
        leading={<GitHubMark size={20} color={palette.text} />}
        onPress={url === null ? undefined : () => { openExternal(url); }}
      />
    </Rows>
  );
}

const skillFacts = (skill: ClaudeSkill): string | undefined =>
  [skill.description, skill.updatedAt === null ? '' : `Changed ${whenLabel(skill.updatedAt)}.`].filter((part) => part !== '').join(' ') || undefined;

function DeleteSkill({ skill, project }: { skill: ClaudeSkill; project: string }): ReactNode {
  const client = useQueryClient();
  if (skill.managed === true) return null;
  return (
    <DeleteMenu
      label={`Actions for ${skill.name}`}
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

interface ActionsProps {
  busy: boolean;
  changed: boolean;
  note: string | null;
  failure: string | null;
  onSave: () => void;
  onRevert: () => void;
}

function Actions({ busy, changed, note, failure, onSave, onRevert }: ActionsProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row gap={12} align="center" wrap>
      <Button size="lg" dark={dark} label={busy ? 'Saving…' : 'Save'} loading={busy} disabled={busy || !changed} onPress={onSave} />
      <Button size="lg" color="secondary" dark={dark} label="Revert" disabled={busy || !changed} onPress={onRevert} />
      {note === null ? null : <Text size="md" role="secondary">{note}</Text>}
      {failure === null ? null : <Text size="md" role="danger">{failure}</Text>}
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

export function SkillPage({ project, id }: SkillPageProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { data, error } = useClaudeSkillQuery(id);
  const edit = useSkillEditor(data);
  useDocumentTitle(data?.title ?? 'Skill');

  return (
    <Col gap={8}>
      <Crumbs items={[{ label: 'Skills', href: routeHash({ kind: 'skills', project }) }, { label: data?.title ?? 'Skill' }]} />
      {error !== null ? (
        <StateBlock icon="exclamationCircle" danger title="Could not read that skill" text={queryError(error, 'Try again in a moment.')} />
      ) : data === undefined ? (
        <Loading />
      ) : (
        <Col gap={20}>
          <PageHeader title={data.title} subtitle={skillFacts(data)} action={<DeleteSkill skill={data} project={project} />} />
          <Managed skill={data} />
          <FormField label="Skill contents"
            name="skill"
            value={edit.shown}
            dark={dark}
            disabled={edit.busy || !data.editable}
            onChangeText={edit.setDraft}
            style={[GROW, EDITOR]}
            inputProps={NO_ASSIST}
          />
          {data.managed === true ? null : <Actions
            busy={edit.busy}
            changed={edit.changed}
            note={edit.note}
            failure={edit.failure}
            onSave={edit.save}
            onRevert={edit.revert}
          />}
        </Col>
      )}
    </Col>
  );
}
