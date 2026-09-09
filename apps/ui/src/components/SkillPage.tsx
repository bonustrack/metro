import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button, Input, Text } from './ui.js';
import { GROW } from '../theme.js';
import { Loading } from './Loading.js';
import { PageTitle } from './PageTitle.js';
import { BackLink } from './BackLink.js';
import { FieldLabel } from './FieldLabel.js';
import { routeHash } from '../route.js';
import { whenLabel } from '../api/when.js';
import { saveClaudeSkill, type ClaudeSkill } from '../api/claude.js';
import { queryError, refreshClaudeSkills, useClaudeSkillQuery } from '../api/queries.js';
import { useDocumentTitle } from '../title.js';

const EDITOR = { minHeight: 420, lineHeight: 22 } as const;
const NO_ASSIST = { multiline: true, autoCapitalize: 'none', autoCorrect: false, spellCheck: false } as const;
const SAVED = 'Saved. The next Claude Code session on this machine reads it.';

function Head({ skill }: { skill: ClaudeSkill }): ReactNode {
  return (
    <Col gap={16}>
      <Col gap={8}>
        <PageTitle>{skill.title}</PageTitle>
        <Text size="sm" role="secondary">{skill.description}</Text>
      </Col>
      <Col gap={2}>
        <FieldLabel>{skill.scope === 'user' ? 'This machine' : skill.where}</FieldLabel>
        <Text size="sm" role="secondary">{skill.path}</Text>
        <Text size="sm" role="secondary">{skill.updatedAt === null ? '' : `Last changed ${whenLabel(skill.updatedAt)}.`}</Text>
      </Col>
      {skill.editable ? null : <Text size="sm" role="danger">That skill is too large to edit here.</Text>}
    </Col>
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
      <Button dark={dark} label={busy ? 'Saving…' : 'Save'} loading={busy} disabled={busy || !changed} onPress={onSave} />
      <Button size="md" color="secondary" dark={dark} label="Revert" disabled={busy || !changed} onPress={onRevert} />
      {note === null ? null : <Text size="sm" role="secondary">{note}</Text>}
      {failure === null ? null : <Text size="sm" role="danger">{failure}</Text>}
    </Row>
  );
}

interface SkillPageProps {
  project: string;
  id: string;
  onBack: () => void;
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

export function SkillPage({ project, id, onBack }: SkillPageProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { data, error } = useClaudeSkillQuery(id);
  const edit = useSkillEditor(data);
  useDocumentTitle(data?.title ?? 'Skill');

  return (
    <Col gap={20}>
      <BackLink label="Skills" href={routeHash({ kind: 'skills', project })} onPress={onBack} />
      {error !== null ? (
        <Text size="sm" role="danger">{queryError(error, 'Could not read that skill.')}</Text>
      ) : data === undefined ? (
        <Loading />
      ) : (
        <Col gap={16}>
          <Head skill={data} />
          <Input
            name="skill"
            value={edit.shown}
            dark={dark}
            disabled={edit.busy || !data.editable}
            onChangeText={edit.setDraft}
            style={[GROW, EDITOR]}
            inputProps={NO_ASSIST}
          />
          <Actions
            busy={edit.busy}
            changed={edit.changed}
            note={edit.note}
            failure={edit.failure}
            onSave={edit.save}
            onRevert={edit.revert}
          />
        </Col>
      )}
    </Col>
  );
}
